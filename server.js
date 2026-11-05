// Backend Node.js para o jogo (múltiplas salas, reconexão e verificação por IA)
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

// Quanto tempo a vaga de um jogador desconectado fica reservada antes de ele ser removido
const RECONEXAO_MS = (Number(process.env.TEMPO_RECONEXAO_SEGUNDOS) || 45) * 1000;
// Útil só para testar sozinho com várias abas (desliga a regra "um jogador por computador")
const PERMITIR_MULTIPLAS_ABAS = /^(1|true|sim)$/i.test(process.env.PERMITIR_MULTIPLAS_ABAS || '');

const ALFABETO_CODIGO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem O/0/I/1 pra evitar confusão
const SALA_BROWSE = 'browse'; // socket.io room de quem está olhando a lista de salas públicas

// Todas as salas ativas: codigo -> objeto da sala
const salas = new Map();

// ---------------------------------------------------------------------------
// IDENTIFICAÇÃO DO COMPUTADOR (cookie) — base da regra "um jogador por computador"
// ---------------------------------------------------------------------------
function lerCookie(header, nome) {
    if (!header) return null;
    for (const parte of header.split(';')) {
        const i = parte.indexOf('=');
        if (i > -1 && parte.slice(0, i).trim() === nome) {
            try { return decodeURIComponent(parte.slice(i + 1).trim()); } catch (e) { return null; }
        }
    }
    return null;
}

app.use((req, res, next) => {
    if (!lerCookie(req.headers.cookie, 'mid')) {
        res.cookie('mid', crypto.randomUUID(), { httpOnly: true, sameSite: 'lax', maxAge: 365 * 24 * 3600 * 1000, path: '/' });
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Remove tags HTML e corta o texto num tamanho máximo. Usado em qualquer
// texto que vem do cliente (nome, fato, mensagem de chat) antes de guardar
// ou retransmitir, pra evitar injeção de HTML/JS em quem exibe via innerHTML.
function sanitizeTexto(texto, maxLen) {
    if (typeof texto !== 'string') return '';
    return texto.replace(/<[^>]*>/g, '').trim().slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// SALAS E JOGADORES
//
// Cada jogador tem um `id` ESTÁVEL (nunca muda, mesmo se reconectar) e um `sock`
// (o socket atual, ou null enquanto ele está desconectado). Toda a lógica do
// jogo usa `id`, nunca o id do socket.
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
        detetiveRevelado: false,
        votacaoLiberada: false,
        jogadorMortoId: null,
        apresentacaoConcluidaIds: new Set(),
        fatosEmVerificacao: new Set(),
        rejeicoesIA: {},
        ultimoResultado: null,
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
    sala.jogadores.forEach(j => clearTimeout(j.timer));
    salas.delete(sala.codigo);
}

// Jogador está "presente" se tem um socket vivo ainda dentro da sala dele
function conectado(j) {
    if (!j.sock) return false;
    const s = io.sockets.sockets.get(j.sock);
    return !!s && s.data.sala === j.sala;
}

function emitirPara(j, evento, dados) {
    if (conectado(j)) io.to(j.sock).emit(evento, dados);
}

// Jogador e sala a que o socket pertence (ou null)
function contexto(socket) {
    const sala = socket.data.sala ? salas.get(socket.data.sala) : null;
    if (!sala) return null;
    const jogador = sala.jogadores.find(j => j.id === socket.data.jogadorId);
    return jogador ? { sala, jogador } : null;
}

// Mantém sempre um anfitrião. O anfitrião desconectado conserva o posto durante
// o tempo de reconexão; só perde se for removido.
function garantirHost(sala) {
    if (sala.jogadores.some(j => j.token === sala.hostToken)) return;
    const novo = sala.jogadores.find(conectado) || sala.jogadores[0];
    sala.hostToken = novo ? novo.token : null;
}

function resetarRodada(sala) {
    sala.fatos = {};
    sala.votosRecebidos = {};
    sala.mentirosoId = null;
    sala.detetiveId = null;
    sala.deducaoUsada = false;
    sala.mataUsada = false;
    sala.detetiveRevelado = false;
    sala.votacaoLiberada = false;
    sala.jogadorMortoId = null;
    sala.apresentacaoConcluidaIds = new Set();
    sala.fatosEmVerificacao = new Set();
    sala.rejeicoesIA = {};
}

function listaJogadoresPublica(sala) {
    return sala.jogadores.map(j => ({
        id: j.id,
        nome: j.nome,
        score: j.score,
        host: j.token === sala.hostToken,
        offline: !conectado(j)
    }));
}

function emitirListaJogadores(sala) {
    io.to(sala.codigo).emit('playerListUpdate', listaJogadoresPublica(sala));
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

// ---------------------------------------------------------------------------
// ANDAMENTO DA RODADA (checagens que podem ser reavaliadas quando alguém sai)
// ---------------------------------------------------------------------------

// Passa para a apresentação quando todo jogador da sala já tem curiosidade aceita.
function concluirColetaSeCompleta(sala) {
    if (sala.estado !== ESTADO_SALA.FATOS) return;
    if (sala.jogadores.length === 0 || !sala.jogadores.every(j => sala.fatos[j.id])) return;

    sala.estado = ESTADO_SALA.VOTACAO;
    sala.votacaoLiberada = false;
    sala.apresentacaoConcluidaIds = new Set();

    io.to(sala.codigo).emit('allFactsCollected', {
        fatos: sala.fatos,
        jogadores: sala.jogadores.map(j => ({ id: j.id, nome: j.nome }))
    });
    io.to(sala.codigo).emit('gameState', { estado: sala.estado });
}

// Só libera a tela de votação quando TODOS terminaram de ver as curiosidades.
function verificarLiberacaoVotacao(sala) {
    if (sala.estado !== ESTADO_SALA.VOTACAO || sala.votacaoLiberada) return;
    const participantes = sala.jogadores.filter(j => sala.fatos[j.id]);
    if (participantes.length > 0 && participantes.every(j => sala.apresentacaoConcluidaIds.has(j.id))) {
        sala.votacaoLiberada = true;
        io.to(sala.codigo).emit('liberarVotacao');
    }
}

// Fecha a rodada quando todos que podem votar já votaram.
function verificarVotosCompletos(sala) {
    if (sala.estado !== ESTADO_SALA.VOTACAO || !sala.votacaoLiberada) return;
    const participantes = sala.jogadores.filter(j => sala.fatos[j.id] && j.id !== sala.jogadorMortoId);
    if (participantes.length === 0 || !participantes.every(j => sala.votosRecebidos[j.id])) return;

    const ids = new Set(participantes.map(j => j.id));
    const votosValidos = {};
    for (const [eleitor, alvo] of Object.entries(sala.votosRecebidos)) {
        if (ids.has(eleitor) && ids.has(alvo)) votosValidos[eleitor] = alvo;
    }
    finalizarRodada(sala, processarVotos(participantes, sala.mentirosoId, votosValidos));
}

function reavaliarSala(sala) {
    if (sala.estado === ESTADO_SALA.FATOS) {
        concluirColetaSeCompleta(sala);
    } else if (sala.estado === ESTADO_SALA.VOTACAO) {
        verificarLiberacaoVotacao(sala);
        verificarVotosCompletos(sala);
    }
}

function voltarAoLobby(sala, aviso) {
    sala.estado = ESTADO_SALA.LOBBY;
    sala.timers.forEach(clearTimeout);
    sala.timers = [];
    resetarRodada(sala);
    io.to(sala.codigo).emit('gameState', { estado: sala.estado });
    if (aviso) io.to(sala.codigo).emit('aviso', { texto: aviso });
}

// Tira o jogador DEFINITIVAMENTE da sala (saiu, ou o tempo de reconexão acabou)
function removerJogador(sala, jogador) {
    clearTimeout(jogador.timer);
    const idx = sala.jogadores.indexOf(jogador);
    if (idx === -1) return;
    sala.jogadores.splice(idx, 1);

    if (sala.jogadores.length === 0) {
        destruirSala(sala);
        emitirListaSalas();
        return;
    }

    garantirHost(sala);

    const emJogo = sala.estado !== ESTADO_SALA.LOBBY && sala.estado !== ESTADO_SALA.RESULTADO;
    if (emJogo) {
        if (sala.jogadores.length < 2) {
            voltarAoLobby(sala, 'A partida foi encerrada: não há jogadores suficientes.');
        } else if (jogador.id === sala.mentirosoId) {
            voltarAoLobby(sala, 'O Mentiroso saiu da sala. A rodada foi cancelada.');
        } else {
            if (jogador.id === sala.detetiveId) sala.detetiveId = null;
            reavaliarSala(sala); // quem faltava podia ser o último que o jogo esperava
        }
    }

    emitirListaJogadores(sala);
    emitirListaSalas();
}

// Saída voluntária (botão "Sair da sala" ou troca de sala)
function sairDaSala(socket) {
    const c = contexto(socket);
    socket.data.sala = null;
    socket.data.jogadorId = null;
    if (!c) return;
    socket.leave(c.sala.codigo);
    c.jogador.sock = null;
    removerJogador(c.sala, c.jogador);
}

// Conexão caiu (aba fechada, rede, reload): reserva a vaga por RECONEXAO_MS
function aoDesconectar(socket) {
    const c = contexto(socket);
    if (!c) return;
    const { sala, jogador } = c;
    if (jogador.sock !== socket.id) return; // já foi assumido por outra conexão

    jogador.sock = null;
    jogador.offlineDesde = Date.now();
    clearTimeout(jogador.timer);
    jogador.timer = setTimeout(() => {
        if (salas.get(sala.codigo) === sala && sala.jogadores.includes(jogador) && !conectado(jogador)) {
            removerJogador(sala, jogador);
        }
    }, RECONEXAO_MS);

    emitirListaJogadores(sala);
    emitirListaSalas();
}

// Remove, sem esperar, quem está desconectado (usado ao iniciar a partida)
function removerOffline(sala) {
    sala.jogadores = sala.jogadores.filter(j => {
        if (conectado(j)) return true;
        clearTimeout(j.timer);
        return false;
    });
    garantirHost(sala);
}

// Um computador (cookie) só pode ter UM jogador conectado por vez
function computadorEmUso(deviceId, exceto) {
    if (!deviceId || PERMITIR_MULTIPLAS_ABAS) return false;
    for (const sala of salas.values()) {
        for (const j of sala.jogadores) {
            if (j !== exceto && j.deviceId === deviceId && conectado(j)) return true;
        }
    }
    return false;
}

// Reenvia ao socket tudo que ele precisa para voltar ao ponto em que a sala está
function enviarEstado(socket, sala, jogador) {
    socket.emit('sessionToken', jogador.token);
    socket.emit('roomJoined', { codigo: sala.codigo, publica: sala.publica, jogadorId: jogador.id });
    socket.emit('playerListUpdate', listaJogadoresPublica(sala));

    const estado = sala.estado;
    const base = { estado, jogadorId: jogador.id };

    if (estado === ESTADO_SALA.LOBBY) {
        socket.emit('gameState', base);
        return;
    }
    if (estado === ESTADO_SALA.RESULTADO) {
        if (sala.ultimoResultado) socket.emit('finalResults', sala.ultimoResultado);
        socket.emit('gameState', base);
        return;
    }

    if (jogador.role) socket.emit('roleAssignment', { role: jogador.role, tema: sala.temaAtual, detetiveHint: null });
    if (estado === ESTADO_SALA.VOTACAO) {
        socket.emit('allFactsCollected', {
            fatos: sala.fatos,
            jogadores: sala.jogadores.filter(j => sala.fatos[j.id]).map(j => ({ id: j.id, nome: j.nome }))
        });
    }
    socket.emit('gameState', base);

    if (estado === ESTADO_SALA.FATOS && sala.fatos[jogador.id]) socket.emit('fatoAceito');

    if (estado === ESTADO_SALA.VOTACAO && sala.votacaoLiberada) {
        socket.emit('liberarVotacao');
        if (sala.votosRecebidos[jogador.id]) socket.emit('votoRegistrado', { votadoId: sala.votosRecebidos[jogador.id] });
        if (sala.jogadorMortoId) socket.emit('jogadorEliminado', { id: sala.jogadorMortoId });
        if (jogador.id === sala.detetiveId && sala.deducaoUsada) socket.emit('deducaoErrada');
        if (jogador.id === sala.mentirosoId) {
            if (sala.mataUsada) socket.emit('habilidadeUsada');
            if (sala.detetiveRevelado) {
                const det = sala.jogadores.find(j => j.id === sala.detetiveId);
                if (det) socket.emit('detetiveRevelado', { id: det.id, nome: det.nome });
            }
        }
    }
}

// Coloca o socket na sala: jogador novo OU reconexão (mesmo nome + token). true se deu certo.
function entrarNaSala(socket, sala, nomeJogador, tokenRecebido, { rejoin = false } = {}) {
    const falha = (msg) => socket.emit(rejoin ? 'rejoinFalhou' : 'error', rejoin ? { motivo: msg } : msg);

    const existente = sala.jogadores.find(j => j.nome === nomeJogador);
    let jogador = null;

    if (existente) {
        // Ninguém assume uma identidade sem o token dela (nem se estiver desconectada)
        if (!tokenRecebido || existente.token !== tokenRecebido) {
            falha('Nome já em uso nesta sala.');
            return false;
        }
        jogador = existente;
    } else {
        if (rejoin) { falha('Você não faz mais parte desta sala.'); return false; }
        if (sala.estado !== ESTADO_SALA.LOBBY) {
            falha('A partida já começou nesta sala. Aguarde ela voltar ao lobby.');
            return false;
        }
        if (sala.jogadores.length >= MAX_JOGADORES) { falha('Sala cheia.'); return false; }
    }

    const deviceId = socket.data.deviceId;
    if (computadorEmUso(deviceId, jogador)) {
        falha('Este computador já tem um jogador conectado (outra aba aberta). Use apenas uma aba.');
        return false;
    }

    if (!jogador) {
        jogador = {
            id: socket.id, // id estável: o do primeiro socket, mantido para sempre
            sock: null,
            nome: nomeJogador,
            sala: sala.codigo,
            role: 'inocente',
            score: 0,
            token: crypto.randomUUID(),
            deviceId: null,
            timer: null,
            offlineDesde: null
        };
        sala.jogadores.push(jogador);
    } else if (jogador.sock && jogador.sock !== socket.id) {
        // A conexão antiga (outra aba) é substituída por esta
        const antigo = io.sockets.sockets.get(jogador.sock);
        if (antigo) {
            antigo.data.sala = null;
            antigo.data.jogadorId = null;
            antigo.leave(sala.codigo);
            antigo.emit('substituido');
        }
    }

    clearTimeout(jogador.timer);
    jogador.timer = null;
    jogador.offlineDesde = null;
    jogador.sock = socket.id;
    jogador.deviceId = deviceId;

    socket.data.sala = sala.codigo;
    socket.data.jogadorId = jogador.id;
    socket.data.nome = nomeJogador;
    socket.leave(SALA_BROWSE);
    socket.join(sala.codigo);

    if (!sala.hostToken) sala.hostToken = jogador.token;
    garantirHost(sala);

    enviarEstado(socket, sala, jogador);
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
    socket.data.deviceId = lerCookie(socket.handshake.headers.cookie, 'mid');
    console.log(`Novo jogador conectado: ${socket.id}`);

    // Quem está na tela de escolha de sala recebe a lista de salas públicas
    socket.on('listRooms', () => {
        if (!socket.data.sala) socket.join(SALA_BROWSE);
        socket.emit('roomList', listaSalasPublicas());
    });

    socket.on('createRoom', (payload) => {
        const nome = validarNome(socket, payload && payload.nome);
        if (!nome) return;

        sairDaSala(socket);
        const sala = criarSala(payload && payload.publica);
        if (!entrarNaSala(socket, sala, nome, payload && payload.token)) destruirSala(sala);
    });

    socket.on('joinRoom', (payload) => {
        const nome = validarNome(socket, payload && payload.nome);
        if (!nome) return;
        const codigo = sanitizeTexto(payload && payload.codigo, 10).toUpperCase();

        const sala = salas.get(codigo);
        if (!sala) {
            socket.emit('error', 'Sala não encontrada. Confira o código.');
            return;
        }

        if (socket.data.sala && socket.data.sala !== codigo) sairDaSala(socket);
        entrarNaSala(socket, sala, nome, payload && payload.token);
    });

    // Volta para a sala depois de recarregar a página ou perder a conexão
    socket.on('rejoinRoom', (payload) => {
        const nome = sanitizeTexto(payload && payload.nome, 20);
        const codigo = sanitizeTexto(payload && payload.codigo, 10).toUpperCase();
        const sala = salas.get(codigo);
        if (!sala || nome.length < 3) {
            socket.emit('rejoinFalhou', { motivo: 'A sala não existe mais.' });
            return;
        }
        if (socket.data.sala && socket.data.sala !== codigo) sairDaSala(socket);
        entrarNaSala(socket, sala, nome, payload && payload.token, { rejoin: true });
    });

    socket.on('leaveRoom', () => {
        sairDaSala(socket);
    });

    socket.on('startGame', () => {
        const c = contexto(socket);
        if (!c) return;
        const { sala, jogador } = c;
        if (jogador.token !== sala.hostToken) return; // só o anfitrião inicia
        if (sala.estado !== ESTADO_SALA.LOBBY) return;

        removerOffline(sala);
        emitirListaJogadores(sala);
        emitirListaSalas();
        if (sala.jogadores.length < 2) return;

        sala.jogadores.forEach(j => j.role = 'inocente');
        resetarRodada(sala);

        const mentiroso = sala.jogadores[Math.floor(Math.random() * sala.jogadores.length)];
        mentiroso.role = 'mentiroso';
        sala.mentirosoId = mentiroso.id;

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
            emitirPara(j, 'roleAssignment', { role: j.role, tema: sala.temaAtual, detetiveHint: null });
        });

        io.to(sala.codigo).emit('gameState', { estado: sala.estado });
        emitirListaJogadores(sala);
        emitirListaSalas(); // sala deixou de estar disponível pra entrar

        agendar(sala, () => {
            if (sala.estado !== ESTADO_SALA.ROLE) return;
            sala.estado = ESTADO_SALA.FATOS;
            io.to(sala.codigo).emit('gameState', { estado: sala.estado });
        }, 3000);
    });

    // COLETA DE FATOS (com verificação opcional por IA)
    socket.on('submitFact', async (fatoBruto) => {
        const c = contexto(socket);
        if (!c) return;
        const { sala, jogador } = c;
        if (sala.estado !== ESTADO_SALA.FATOS) return;
        if (sala.fatos[jogador.id] || sala.fatosEmVerificacao.has(jogador.id)) return;

        const fato = sanitizeTexto(fatoBruto, 600);
        if (fato.length < 5) {
            socket.emit('fatoRejeitado', { motivo: 'Fato muito curto (mínimo de 5 caracteres).' });
            return;
        }

        const rejeicoes = sala.rejeicoesIA[jogador.id] || 0;
        if (iaAtiva() && rejeicoes < MAX_REJEICOES_IA) {
            sala.fatosEmVerificacao.add(jogador.id);
            const veredito = await verificarCuriosidade(sala.temaAtual, fato);
            sala.fatosEmVerificacao.delete(jogador.id);

            // Durante a espera a sala pode ter mudado ou o jogador pode ter saído
            if (salas.get(sala.codigo) !== sala || sala.estado !== ESTADO_SALA.FATOS || !sala.jogadores.includes(jogador)) return;

            const decisao = decidir(jogador.role, sala.temaAtual, veredito);
            if (!decisao.aceitar) {
                sala.rejeicoesIA[jogador.id] = rejeicoes + 1;
                emitirPara(jogador, 'fatoRejeitado', {
                    motivo: decisao.motivo,
                    tentativa: rejeicoes + 1,
                    max: MAX_REJEICOES_IA
                });
                return;
            }
        }

        sala.fatos[jogador.id] = fato;
        emitirPara(jogador, 'fatoAceito');
        concluirColetaSeCompleta(sala);
    });

    // CHAT (só pra quem está na mesma sala)
    socket.on('chatMessage', (messageBruto) => {
        const c = contexto(socket);
        if (!c) return;
        const message = sanitizeTexto(messageBruto, 250);
        if (!message) return;
        io.to(c.sala.codigo).emit('receiveMessage', { sender: c.jogador.nome, text: message });
    });

    // Jogador terminou de ver todas as curiosidades (viu até o fim ou pulou)
    socket.on('apresentacaoConcluida', () => {
        const c = contexto(socket);
        if (!c || c.sala.estado !== ESTADO_SALA.VOTACAO) return;
        c.sala.apresentacaoConcluidaIds.add(c.jogador.id);
        verificarLiberacaoVotacao(c.sala);
    });

    // VOTAÇÃO — o voto de todos (inclusive do Detetive) vale igual
    socket.on('submitVote', (votadoId) => {
        const c = contexto(socket);
        if (!c) return;
        const { sala, jogador } = c;

        if (sala.estado !== ESTADO_SALA.VOTACAO || !sala.votacaoLiberada) return;
        if (sala.votosRecebidos[jogador.id] || !sala.fatos[jogador.id]) return;
        if (jogador.id === sala.jogadorMortoId) return;
        if (votadoId === jogador.id) return;
        if (!sala.fatos[votadoId] || votadoId === sala.jogadorMortoId) return;
        if (!sala.jogadores.some(j => j.id === votadoId)) return;

        sala.votosRecebidos[jogador.id] = votadoId;
        verificarVotosCompletos(sala);
    });

    // DETETIVE: dedução direta (a única forma de ele vencer a rodada sozinho)
    socket.on('detectiveDeduce', (alvoId) => {
        const c = contexto(socket);
        if (!c) return;
        const { sala, jogador } = c;
        if (sala.estado !== ESTADO_SALA.VOTACAO || !sala.votacaoLiberada) return;
        if (jogador.id !== sala.detetiveId) return;
        if (sala.jogadorMortoId === sala.detetiveId) return;
        if (sala.deducaoUsada) return;
        if (!sala.fatos[alvoId] || alvoId === jogador.id) return;

        sala.deducaoUsada = true;

        const jogadoresNaRodada = sala.jogadores.filter(j => sala.fatos[j.id] && j.id !== sala.jogadorMortoId);
        const acertou = alvoId === sala.mentirosoId;

        if (!acertou) {
            // Não encerra a rodada: o detetive é avisado e o impostor descobre quem ele é
            sala.detetiveRevelado = true;
            socket.emit('deducaoErrada');
            const mentiroso = sala.jogadores.find(j => j.id === sala.mentirosoId);
            if (mentiroso) emitirPara(mentiroso, 'detetiveRevelado', { id: jogador.id, nome: jogador.nome });
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
        const c = contexto(socket);
        if (!c) return;
        const { sala, jogador } = c;
        if (sala.estado !== ESTADO_SALA.VOTACAO || !sala.votacaoLiberada) return;
        if (jogador.id !== sala.mentirosoId) return;
        if (sala.mataUsada) return;
        if (alvoId === jogador.id) return;
        if (!sala.fatos[alvoId]) return;

        sala.mataUsada = true;

        if (alvoId === sala.detetiveId) {
            sala.jogadorMortoId = alvoId;
            delete sala.votosRecebidos[alvoId];
            io.to(sala.codigo).emit('jogadorEliminado', { id: alvoId });
            verificarVotosCompletos(sala); // o voto que faltava pode ter sido o do eliminado
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
        aoDesconectar(socket);
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
    sala.ultimoResultado = resultadoFinal; // quem reconectar durante o resultado também o vê

    io.to(sala.codigo).emit('finalResults', resultadoFinal);
    emitirListaJogadores(sala);
    io.to(sala.codigo).emit('gameState', { estado: sala.estado });

    agendar(sala, () => {
        sala.estado = ESTADO_SALA.LOBBY;
        sala.ultimoResultado = null;
        garantirHost(sala);
        io.to(sala.codigo).emit('gameState', { estado: sala.estado });
        emitirListaJogadores(sala);
        emitirListaSalas();
    }, 10000);
}

// Todos os jogadores (inclusive o Detetive) seguem a MESMA regra: vale a maioria.
// O Detetive só vence a rodada sozinho usando a habilidade de dedução direta.
// Empate no topo = ninguém é acusado = o Mentiroso escapa.
function processarVotos(jogadoresNaRodada, idMentiroso, votos) {
    const contagemVotos = {};
    const mentirosoReal = jogadoresNaRodada.find(j => j.id === idMentiroso);

    jogadoresNaRodada.forEach(j => contagemVotos[j.id] = 0);
    for (const votadoId of Object.values(votos)) {
        if (contagemVotos[votadoId] !== undefined) contagemVotos[votadoId]++;
    }

    const maisVotos = Math.max(...Object.values(contagemVotos));
    const topo = Object.keys(contagemVotos).filter(id => contagemVotos[id] === maisVotos);
    const acusadoId = topo.length === 1 ? topo[0] : null;

    const pontuacoes = jogadoresNaRodada.map(j => ({ id: j.id, pontos: 0 }));
    let vencedor;

    if (acusadoId === idMentiroso) {
        // Inocentes pegaram o Mentiroso: quem votou nele ganha 5
        vencedor = 'inocentes';
        for (const eleitorId in votos) {
            if (votos[eleitorId] !== idMentiroso) continue;
            const eleitor = jogadoresNaRodada.find(j => j.id === eleitorId);
            if (eleitor && (eleitor.role === 'inocente' || eleitor.role === 'detetive')) {
                const p = pontuacoes.find(x => x.id === eleitorId);
                if (p) p.pontos = 5;
            }
        }
    } else {
        // A maioria errou (ou empatou): o Mentiroso escapa e ganha 10
        vencedor = 'mentiroso';
        const p = pontuacoes.find(x => x.id === idMentiroso);
        if (p) p.pontos = 10;
    }

    return {
        contagem: contagemVotos,
        mentirosoReal: mentirosoReal ? { id: mentirosoReal.id, nome: mentirosoReal.nome } : { id: 'desconhecido', nome: 'Desconhecido' },
        acusadoId,
        vencedor,
        pontuacoes,
        votoDetetive: null
    };
}

// ==========================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor rodando na porta http://localhost:${PORT}`);
});
