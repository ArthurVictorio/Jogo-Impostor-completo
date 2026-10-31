// Backend Node.js para o jogo (múltiplas salas)
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { iaAtiva, verificarCuriosidade, decidir } = require('./verificador'); // também carrega o .env

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const TEMAS = [
    "ANIMES EM GERAL",
    "ANIMAIS DOMESTICOS",
    "FILMES EM GERAL",
    "ANIMAIS SELVAGENS",
    "ESCOLA",
    "FILMES DA DC",
    "FILMES DA MARVEL",
    "JOGOS EM GERAL",
    "FILMES DE ANIMES",
    "JOGOS MOBILE",
    "JOGOS DE PC",
    "JOGOS DO ROBLOX",
    "CLASH ROYALE",
    "ONE PIECE",
    "DEMON SLAYER",
    "ATACK ON TITAN",
    "YOUTUBERS",
    "INSTAGRAM EM GERAL",
    "TIKTOK EM GERAL",
    "PERSONAGENS DE ANIMES"
];

const ESTADO_SALA = {
    LOBBY: 'lobby',
    ROLE: 'espera-role',
    FATOS: 'coletandoFatos',
    VOTACAO: 'votando',
    RESULTADO: 'resultado'
};

const MAX_JOGADORES = 12;
const MAX_REJEICOES_IA = 3; // depois de 3 rejeições a próxima curiosidade é aceita sem verificação
const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O/0/I/1 pra evitar confusão
const SALA_BROWSE = 'browse'; // socket.io room de quem está olhando a lista de salas públicas

// Todas as salas ativas: codigo -> objeto da sala
const salas = new Map();

app.use(express.static(path.join(__dirname, 'public')));

// Remove tags HTML e corta o texto num tamanho máximo. Usado em qualquer
// texto que vem do cliente (nome, fato, mensagem de chat) antes de guardar
// ou retransmitir, pra evitar injeção de HTML/JS em quem exibe via innerHTML.
function sanitizeTexto(texto, maxLen) {
    if (typeof texto !== 'string') return '';
    return texto.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// SALAS
// ---------------------------------------------------------------------------

function gerarCodigoSala() {
    let codigo;
    do {
        codigo = '';
        for (let i = 0; i < 5; i++) {
            codigo += ALFABETO_CODIGO[crypto.randomInt(ALFABETO_CODIGO.length)];
        }
    } while (salas.has(codigo));
    return codigo;
}

function criarSala(publica) {
    const sala = {
        codigo: gerarCodigoSala(),
        publica: !!publica,
        hostToken: null,
        jogadores: [],
        estado: ESTADO_SALA.LOBBY,
        fatos: {},
        mentirosoId: null,
        detetiveId: null,
        votosRecebidos: {},
        temaAtual: null,
        deducaoUsada: false,
        mataUsada: false,
        jogadorMortoId: null,
        apresentacaoConcluidaIds: new Set(),
        fatosEmVerificacao: new Set(),
        rejeicoesIA: {},
        timers: []
    };
    salas.set(sala.codigo, sala);
    return sala;
}

function agendar(sala, fn, ms) {
    const t = setTimeout(() => {
        sala.timers = sala.timers.filter(x => x !== t);
        if (salas.get(sala.codigo) === sala) fn();
    }, ms);
    sala.timers.push(t);
}

function destruirSala(sala) {
    sala.timers.forEach(clearTimeout);
    sala.timers = [];
    salas.delete(sala.codigo);
}

// Jogador está "presente" se o socket existe E ainda está dentro da sala dele
function conectado(j) {
    const s = io.sockets.sockets.get(j.id);
    return !!s && s.data.sala === j.sala;
}

function removerJogadoresDesconectados(sala) {
    sala.jogadores = sala.jogadores.filter(conectado);
}

// Garante que a sala sempre tem um anfitrião conectado
function garantirHost(sala) {
    const host = sala.jogadores.find(j => j.token === sala.hostToken && conectado(j));
    if (host) return;
    const novo = sala.jogadores.find(conectado);
    sala.hostToken = novo ? novo.token : null;
}

function resetarRodada(sala) {
    sala.fatos = {};
    sala.votosRecebidos = {};
    sala.mentirosoId = null;
    sala.detetiveId = null;
    sala.deducaoUsada = false;
    sala.mataUsada = false;
    sala.jogadorMortoId = null;
    sala.apresentacaoConcluidaIds = new Set();
    sala.fatosEmVerificacao = new Set();
    sala.rejeicoesIA = {};
}

function emitirListaJogadores(sala) {
    io.to(sala.codigo).emit('playerListUpdate', sala.jogadores.map(j => ({
        id: j.id,
        nome: j.nome,
        score: j.score,
        host: j.token === sala.hostToken
    })));
}

function listaSalasPublicas() {
    const lista = [];
    for (const sala of salas.values()) {
        if (!sala.publica || sala.estado !== ESTADO_SALA.LOBBY) continue;
        const ativos = sala.jogadores.filter(conectado);
        if (ativos.length === 0) continue;
        const host = ativos.find(j => j.token === sala.hostToken) || ativos[0];
        lista.push({
            codigo: sala.codigo,
            anfitriao: host.nome,
            jogadores: ativos.length,
            max: MAX_JOGADORES
        });
    }
    return lista;
}

function emitirListaSalas() {
    io.to(SALA_BROWSE).emit('roomList', listaSalasPublicas());
}

function salaDoSocket(socket) {
    const codigo = socket.data.sala;
    return codigo ? salas.get(codigo) : null;
}

// Tira o socket da sala (usado ao sair, ao trocar de sala e ao desconectar)
function sairDaSala(socket) {
    const sala = salaDoSocket(socket);
    socket.data.sala = null;
    if (!sala) return;
    socket.leave(sala.codigo);

    if (sala.estado === ESTADO_SALA.LOBBY) {
        const idx = sala.jogadores.findIndex(j => j.id === socket.id);
        if (idx !== -1) sala.jogadores.splice(idx, 1);
    }

    const conectados = sala.jogadores.filter(conectado);
    if (conectados.length === 0) {
        destruirSala(sala);
        emitirListaSalas();
        return;
    }

    if (conectados.length < 2 && sala.estado !== ESTADO_SALA.LOBBY) {
        sala.estado = ESTADO_SALA.LOBBY;
        sala.timers.forEach(clearTimeout);
        sala.timers = [];
        removerJogadoresDesconectados(sala);
        resetarRodada(sala);
        io.to(sala.codigo).emit('gameState', { estado: sala.estado });
    } else {
        concluirColetaSeCompleta(sala);
        verificarLiberacaoVotacao(sala);
    }

    garantirHost(sala);
    emitirListaJogadores(sala);
    emitirListaSalas();
}

// Passa para a apresentação quando todo jogador presente já tem curiosidade aceita.
function concluirColetaSeCompleta(sala) {
    if (sala.estado !== ESTADO_SALA.FATOS) return;
    const participantes = sala.jogadores.filter(conectado);
    if (participantes.length === 0 || !participantes.every(j => sala.fatos[j.id])) return;

    sala.estado = ESTADO_SALA.VOTACAO;
    sala.apresentacaoConcluidaIds = new Set();

    const jogadoresNaRodada = sala.jogadores.filter(j => sala.fatos[j.id]);
    io.to(sala.codigo).emit('allFactsCollected', {
        fatos: sala.fatos,
        jogadores: jogadoresNaRodada.map(j => ({ id: j.id, nome: j.nome }))
    });
    io.to(sala.codigo).emit('gameState', { estado: sala.estado });
}

// Só libera a tela de votação pra todo mundo quando cada jogador ainda
// conectado que participou da rodada já tiver terminado de ver as curiosidades.
function verificarLiberacaoVotacao(sala) {
    if (sala.estado !== ESTADO_SALA.VOTACAO) return;
    const participantes = sala.jogadores.filter(j => sala.fatos[j.id] && conectado(j));
    if (participantes.length > 0 && participantes.every(j => sala.apresentacaoConcluidaIds.has(j.id))) {
        io.to(sala.codigo).emit('liberarVotacao');
    }
}

// Coloca o socket dentro da sala (novo jogador ou reconexão). Retorna true se deu certo.
function entrarNaSala(socket, sala, nomeJogador, tokenRecebido) {
    if (sala.estado === ESTADO_SALA.LOBBY) removerJogadoresDesconectados(sala);

    const existente = sala.jogadores.find(j => j.nome === nomeJogador);
    let jogadorAtual;

    if (existente) {
        const socketAntigoAtivo = existente.id !== socket.id && conectado(existente);
        // Só "assume" a identidade com o token de sessão correto
        if (socketAntigoAtivo && existente.token !== tokenRecebido) {
            socket.emit('error', 'Nome já em uso por outro jogador nesta sala.');
            return false;
        }
        existente.id = socket.id;
        jogadorAtual = existente;
    } else {
        if (sala.estado !== ESTADO_SALA.LOBBY) {
            socket.emit('error', 'A partida já começou nesta sala. Aguarde ela voltar ao lobby.');
            return false;
        }
        if (sala.jogadores.length >= MAX_JOGADORES) {
            socket.emit('error', 'Sala cheia.');
            return false;
        }
        jogadorAtual = { id: socket.id, nome: nomeJogador, sala: sala.codigo, role: 'inocente', score: 0, token: crypto.randomUUID() };
        sala.jogadores.push(jogadorAtual);
    }

    if (!sala.hostToken) sala.hostToken = jogadorAtual.token;

    socket.data.sala = sala.codigo;
    socket.data.nome = nomeJogador;
    socket.leave(SALA_BROWSE);
    socket.join(sala.codigo);

    socket.emit('sessionToken', jogadorAtual.token);
    socket.emit('roomJoined', { codigo: sala.codigo, publica: sala.publica });
    socket.emit('gameState', {
        estado: sala.estado === ESTADO_SALA.RESULTADO ? ESTADO_SALA.LOBBY : sala.estado,
        jogadorId: socket.id
    });

    garantirHost(sala);
    emitirListaJogadores(sala);
    emitirListaSalas();
    return true;
}

function validarNome(socket, nomeBruto) {
    const nome = sanitizeTexto(nomeBruto, 20);
    if (nome.length < 3) {
        socket.emit('error', 'Nome inválido. Use entre 3 e 20 caracteres.');
        return null;
    }
    return nome;
}

// ---------------------------------------------------------------------------
// CONEXÕES E EVENTOS
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
    console.log(`Novo jogador conectado: ${socket.id}`);

    // Quem está na tela de escolha de sala recebe a lista de salas públicas
    socket.on('listRooms', () => {
        if (!socket.data.sala) socket.join(SALA_BROWSE);
        socket.emit('roomList', listaSalasPublicas());
    });

    socket.on('createRoom', (payload) => {
        const nome = validarNome(socket, payload && payload.nome);
        if (!nome) return;
        const tokenRecebido = payload && payload.token;

        sairDaSala(socket);
        const sala = criarSala(payload && payload.publica);
        if (!entrarNaSala(socket, sala, nome, tokenRecebido)) destruirSala(sala);
    });

    socket.on('joinRoom', (payload) => {
        const nome = validarNome(socket, payload && payload.nome);
        if (!nome) return;
        const codigo = sanitizeTexto(payload && payload.codigo, 10).toUpperCase();
        const tokenRecebido = payload && payload.token;

        const sala = salas.get(codigo);
        if (!sala) {
            socket.emit('error', 'Sala não encontrada. Confira o código.');
            return;
        }

        if (socket.data.sala && socket.data.sala !== codigo) sairDaSala(socket);
        entrarNaSala(socket, sala, nome, tokenRecebido);
    });

    socket.on('leaveRoom', () => {
        sairDaSala(socket);
    });

    socket.on('startGame', () => {
        const sala = salaDoSocket(socket);
        if (!sala) return;
        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador || jogador.token !== sala.hostToken) return; // só o anfitrião inicia
        if (sala.estado !== ESTADO_SALA.LOBBY) return;

        removerJogadoresDesconectados(sala);
        if (sala.jogadores.length < 2) return;

        sala.jogadores.forEach(j => j.role = 'inocente');
        resetarRodada(sala);

        const indexMentiroso = Math.floor(Math.random() * sala.jogadores.length);
        sala.jogadores[indexMentiroso].role = 'mentiroso';
        sala.mentirosoId = sala.jogadores[indexMentiroso].id;

        sala.temaAtual = TEMAS[Math.floor(Math.random() * TEMAS.length)];

        // DETETIVE (mínimo de 3 jogadores)
        if (sala.jogadores.length >= 3) {
            const candidatos = sala.jogadores.filter(j => j.role === 'inocente');
            if (candidatos.length > 0) {
                const detetive = candidatos[Math.floor(Math.random() * candidatos.length)];
                detetive.role = 'detetive';
                sala.detetiveId = detetive.id;
            }
        }

        sala.estado = ESTADO_SALA.ROLE;

        sala.jogadores.forEach(j => {
            io.to(j.id).emit('roleAssignment', { role: j.role, tema: sala.temaAtual, detetiveHint: null });
        });

        io.to(sala.codigo).emit('gameState', { estado: sala.estado });
        emitirListaSalas(); // sala deixou de estar disponível pra entrar

        agendar(sala, () => {
            if (sala.estado !== ESTADO_SALA.ROLE) return;
            sala.estado = ESTADO_SALA.FATOS;
            io.to(sala.codigo).emit('gameState', { estado: sala.estado });
        }, 3000);
    });

    // COLETA DE FATOS (com verificação opcional por IA)
    socket.on('submitFact', async (fatoBruto) => {
        const sala = salaDoSocket(socket);
        if (!sala || sala.estado !== ESTADO_SALA.FATOS) return;
        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;
        if (sala.fatos[socket.id] || sala.fatosEmVerificacao.has(socket.id)) return;

        const fato = sanitizeTexto(fatoBruto, 600);
        if (fato.length < 5) {
            socket.emit('fatoRejeitado', { motivo: 'Fato muito curto (mínimo de 5 caracteres).' });
            return;
        }

        const rejeicoes = sala.rejeicoesIA[socket.id] || 0;
        if (iaAtiva() && rejeicoes < MAX_REJEICOES_IA) {
            sala.fatosEmVerificacao.add(socket.id);
            const veredito = await verificarCuriosidade(sala.temaAtual, fato);
            sala.fatosEmVerificacao.delete(socket.id);

            // Durante a espera a sala pode ter mudado ou o jogador pode ter saído
            if (salas.get(sala.codigo) !== sala || sala.estado !== ESTADO_SALA.FATOS || !conectado(jogador)) return;

            const decisao = decidir(jogador.role, sala.temaAtual, veredito);
            if (!decisao.aceitar) {
                sala.rejeicoesIA[socket.id] = rejeicoes + 1;
                socket.emit('fatoRejeitado', {
                    motivo: decisao.motivo,
                    tentativa: rejeicoes + 1,
                    max: MAX_REJEICOES_IA
                });
                return;
            }
        }

        sala.fatos[socket.id] = fato;
        socket.emit('fatoAceito');
        concluirColetaSeCompleta(sala);
    });

    // CHAT (só pra quem está na mesma sala)
    socket.on('chatMessage', (messageBruto) => {
        const sala = salaDoSocket(socket);
        if (!sala) return;
        const message = sanitizeTexto(messageBruto, 250);
        if (!message) return;
        io.to(sala.codigo).emit('receiveMessage', { sender: socket.data.nome || 'Anônimo', text: message });
    });

    // Jogador terminou de ver todas as curiosidades (viu até o fim ou pulou)
    socket.on('apresentacaoConcluida', () => {
        const sala = salaDoSocket(socket);
        if (!sala || sala.estado !== ESTADO_SALA.VOTACAO) return;
        sala.apresentacaoConcluidaIds.add(socket.id);
        verificarLiberacaoVotacao(sala);
    });

    // VOTAÇÃO
    socket.on('submitVote', (votadoId) => {
        const sala = salaDoSocket(socket);
        if (!sala) return;
        const eleitorId = socket.id;

        if (sala.estado !== ESTADO_SALA.VOTACAO || sala.votosRecebidos[eleitorId]) return;
        if (!sala.fatos[eleitorId]) return;
        if (sala.jogadorMortoId && eleitorId === sala.jogadorMortoId) return;

        sala.votosRecebidos[eleitorId] = votadoId;

        const jogadoresNaRodada = sala.jogadores.filter(j => sala.fatos[j.id] && j.id !== sala.jogadorMortoId);

        if (Object.keys(sala.votosRecebidos).length === jogadoresNaRodada.length) {
            const resultado = processarVotos(jogadoresNaRodada, sala.mentirosoId, sala.detetiveId, sala.votosRecebidos);
            finalizarRodada(sala, resultado);
        }
    });

    // DETETIVE: dedução direta
    socket.on('detectiveDeduce', (alvoId) => {
        const sala = salaDoSocket(socket);
        if (!sala || sala.estado !== ESTADO_SALA.VOTACAO) return;
        if (socket.id !== sala.detetiveId) return;
        if (sala.jogadorMortoId === sala.detetiveId) return;
        if (sala.deducaoUsada) return;

        sala.deducaoUsada = true;

        const jogadoresNaRodada = sala.jogadores.filter(j => sala.fatos[j.id] && j.id !== sala.jogadorMortoId);
        const acertou = alvoId === sala.mentirosoId;

        if (!acertou) {
            // Não encerra a rodada: o detetive é avisado e o impostor descobre quem ele é
            socket.emit('deducaoErrada');
            const detetive = sala.jogadores.find(j => j.id === sala.detetiveId);
            if (sala.mentirosoId && detetive && conectado({ id: sala.mentirosoId, sala: sala.codigo })) {
                io.to(sala.mentirosoId).emit('detetiveRevelado', { id: detetive.id, nome: detetive.nome });
            }
            return;
        }

        const pontuacoes = jogadoresNaRodada.map(j => {
            if (j.id === sala.mentirosoId) return { id: j.id, pontos: 0 };
            if (j.id === sala.detetiveId) return { id: j.id, pontos: 20 };
            return { id: j.id, pontos: 10 };
        });

        const mentirosoReal = jogadoresNaRodada.find(j => j.id === sala.mentirosoId);
        finalizarRodada(sala, {
            contagem: {},
            mentirosoReal: mentirosoReal ? { id: mentirosoReal.id, nome: mentirosoReal.nome } : { id: 'desconhecido', nome: 'Desconhecido' },
            acusadoId: alvoId,
            vencedor: 'detetive',
            pontuacoes,
            motivo: 'deducao_certa',
            votoDetetive: null
        });
    });

    // IMPOSTOR: elimina em segredo quem ele suspeita ser o detetive
    socket.on('impostorKill', (alvoId) => {
        const sala = salaDoSocket(socket);
        if (!sala || sala.estado !== ESTADO_SALA.VOTACAO) return;
        if (socket.id !== sala.mentirosoId) return;
        if (sala.mataUsada) return;
        if (alvoId === sala.mentirosoId) return;
        if (!sala.fatos[alvoId]) return;

        sala.mataUsada = true;

        if (alvoId === sala.detetiveId) {
            sala.jogadorMortoId = alvoId;
            delete sala.votosRecebidos[alvoId];
            io.to(sala.codigo).emit('jogadorEliminado', { id: alvoId });
            return;
        }

        // Errou: rodada acaba como se o impostor tivesse sido descoberto
        const jogadoresNaRodada = sala.jogadores.filter(j => sala.fatos[j.id]);
        const mentirosoReal = jogadoresNaRodada.find(j => j.id === sala.mentirosoId);

        const pontuacoes = jogadoresNaRodada.map(j => {
            if (j.id === sala.mentirosoId || j.id === alvoId) return { id: j.id, pontos: 0 };
            return { id: j.id, pontos: 10 };
        });

        finalizarRodada(sala, {
            contagem: {},
            mentirosoReal: mentirosoReal ? { id: mentirosoReal.id, nome: mentirosoReal.nome } : { id: 'desconhecido', nome: 'Desconhecido' },
            acusadoId: null,
            vitimaId: alvoId,
            vencedor: 'inocentes',
            pontuacoes,
            motivo: 'impostor_errou_alvo',
            votoDetetive: null
        });
    });

    socket.on('disconnect', () => {
        console.log(`Jogador desconectado: ${socket.id}`);
        sairDaSala(socket);
    });
});

// =========================================================================

// Aplica as pontuações de uma rodada, reseta o estado e avisa a sala.
function finalizarRodada(sala, resultadoFinal) {
    sala.estado = ESTADO_SALA.RESULTADO;

    resultadoFinal.pontuacoes.forEach(({ id, pontos }) => {
        const jogador = sala.jogadores.find(j => j.id === id);
        if (jogador) jogador.score += pontos;
    });

    resetarRodada(sala);

    io.to(sala.codigo).emit('finalResults', resultadoFinal);
    emitirListaJogadores(sala);
    io.to(sala.codigo).emit('gameState', { estado: sala.estado });

    agendar(sala, () => {
        sala.estado = ESTADO_SALA.LOBBY;
        removerJogadoresDesconectados(sala);
        garantirHost(sala);
        io.to(sala.codigo).emit('gameState', { estado: sala.estado });
        emitirListaJogadores(sala);
        emitirListaSalas();
    }, 10000);
}

function processarVotos(jogadoresNaRodada, idMentiroso, idDetetive, votos) {
    const contagemVotos = {};
    const mentirosoReal = jogadoresNaRodada.find(j => j.id === idMentiroso);

    jogadoresNaRodada.forEach(j => contagemVotos[j.id] = 0);

    for (const votadoId of Object.values(votos)) {
        if (contagemVotos[votadoId] !== undefined) {
            contagemVotos[votadoId]++;
        }
    }

    let maisVotos = -1;
    let acusadoId = null;
    for (const id in contagemVotos) {
        if (contagemVotos[id] > maisVotos) {
            maisVotos = contagemVotos[id];
            acusadoId = id;
        }
    }

    let vencedor = 'inocentes';
    let votoDetetive = null;

    let pontuacoes = jogadoresNaRodada.map(j => ({ id: j.id, pontos: 0 }));

    if (idDetetive && votos[idDetetive]) {
        votoDetetive = votos[idDetetive];

        // Condição 1: DETETIVE VENCE (10 pontos para ele, 5 para inocentes que acertaram)
        if (votoDetetive === idMentiroso) {
            vencedor = 'detetive';

            const pontuacaoDetetive = pontuacoes.find(p => p.id === idDetetive);
            if (pontuacaoDetetive) pontuacaoDetetive.pontos = 10;

            for (const eleitorId in votos) {
                const eleitor = jogadoresNaRodada.find(j => j.id === eleitorId);
                if (eleitorId !== idDetetive && eleitor && eleitor.role === 'inocente' && votos[eleitorId] === idMentiroso) {
                    const pontuacaoInocente = pontuacoes.find(p => p.id === eleitorId);
                    if (pontuacaoInocente) pontuacaoInocente.pontos = 5;
                }
            }
        }
        // Condição 2: MENTIROSO VENCE (10 pontos para ele)
        else if (votoDetetive && votoDetetive !== idMentiroso) {
            vencedor = 'mentiroso';
            const pontuacaoMentiroso = pontuacoes.find(p => p.id === idMentiroso);
            if (pontuacaoMentiroso) pontuacaoMentiroso.pontos = 10;
        }
    }

    // Lógica padrão (só roda se o Detetive não decidiu a rodada sozinho)
    if (vencedor === 'inocentes') {
        if (acusadoId === idMentiroso) {
            vencedor = 'inocentes';
            for (const eleitorId in votos) {
                if (votos[eleitorId] === idMentiroso) {
                    const eleitor = jogadoresNaRodada.find(j => j.id === eleitorId);
                    if (eleitor && (eleitor.role === 'inocente' || eleitor.role === 'detetive')) {
                        const pontuacaoVotante = pontuacoes.find(p => p.id === eleitorId);
                        if (pontuacaoVotante) pontuacaoVotante.pontos = 5;
                    }
                }
            }
        } else {
            vencedor = 'mentiroso';
            const pontuacaoMentiroso = pontuacoes.find(p => p.id === idMentiroso);
            if (pontuacaoMentiroso) pontuacaoMentiroso.pontos = 10;
        }
    }

    return {
        contagem: contagemVotos,
        mentirosoReal: mentirosoReal ? { id: mentirosoReal.id, nome: mentirosoReal.nome } : { id: 'desconhecido', nome: 'Desconhecido' },
        acusadoId: acusadoId,
        vencedor: vencedor,
        pontuacoes: pontuacoes,
        votoDetetive: idDetetive ? {
            eleitorId: idDetetive,
            votadoId: votos[idDetetive],
            isRevelado: acusadoId === idDetetive
        } : null
    };
}

// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta http://localhost:${PORT}`);
});