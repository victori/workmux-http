import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, BOUNDS, type AppConfig } from './config.js'
import { checkRequest } from './security.js'
import { Tmux } from './adapters/tmux.js'
import { Workmux, DependencyError } from './adapters/workmux.js'
import { Discovery } from './services/discovery.js'
import { InputService, TargetGoneError, UnknownDeliveryError } from './services/input.js'
import { Management, BadRequestError, TargetNotFoundError, ConfirmationError } from './services/management.js'
import { Operations } from './services/operations.js'
import { TerminalHub } from './services/terminal.js'

const MessageBody = z.object({
  text: z.string().min(1).max(32_000),
  requestId: z.string().min(1).max(64),
})

const IdParams = z.object({ id: z.string().min(1).max(64) })

const HunkParams = z.object({ id: z.string().min(1).max(64), action: z.enum(['stage', 'unstage', 'split']) })

const DashboardQuery = z.object({ force: z.literal('1').optional() })

const OutputQuery = z.object({
  lines: z.coerce.number().int().min(10).max(BOUNDS.maxOutputLines).catch(BOUNDS.defaultOutputLines),
})

const DiffQuery = z.object({ mode: z.enum(['wip', 'branch']).catch('wip') })

const TerminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('attach'), agentId: z.string().min(1).max(64), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('input'), data: z.string() }),
  z.object({ type: z.literal('fit'), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('detach') }),
])

const KeysBody = z.object({
  keys: z.array(z.enum([
    'enter', 'esc', 'tab', 'backtab', 'up', 'down', 'left', 'right', 'home', 'end',
    'pgup', 'pgdn', 'bspace', 'space', 'ctrl-c', 'ctrl-d', 'ctrl-u', 'ctrl-a', 'ctrl-e', 'ctrl-l', 'ctrl-r',
  ])).min(1).max(8),
  requestId: z.string().min(1).max(64),
})

const HunkBody = z.object({
  snapshotId: z.string().min(1).max(64),
  file: z.string().min(1).max(1024),
  hunkIndex: z.int().min(0).max(10_000),
  piece: z.string().max(200_000).optional(),
})

const HunkCommentBody = z.object({
  snapshotId: z.string().min(1).max(64),
  file: z.string().min(1).max(1024),
  hunkIndex: z.int().min(0).max(10_000),
  comment: z.string().min(1).max(BOUNDS.maxHunkCommentChars),
  agentId: z.string().min(1).max(64).optional(),
})

const AddBody = z.object({
  paths: z.array(z.string().min(1).max(1024)).min(1).max(BOUNDS.maxAddPaths),
})

const CommitBody = z.object({
  message: z.string().trim().max(BOUNDS.maxCommitMessageBytes).optional(),
})

const PrepareBody = z.object({
  action: z.enum(['merge', 'remove', 'stop', 'close', 'open', 'push']),
  targetId: z.string().min(1).max(64),
  acceptWarnings: z.boolean().optional(),
})

const ExecuteBody = PrepareBody.extend({
  confirmToken: z.string().min(1).max(64),
  requestId: z.string().min(1).max(64),
})

const CreateBody = z.object({
  project: z.string().min(1).max(200),
  name: z.string().min(1).max(64),
  prompt: z.string().max(32_000).optional(),
  agent: z.string().max(32).optional(),
  baseBranch: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/).optional(),
  requestId: z.string().min(1).max(64),
})

export interface AppDeps {
  cfg: AppConfig
  tmux: Tmux
  workmux: Workmux
  discovery: Discovery
  input: InputService
  management: Management
  operations: Operations
  terminals: TerminalHub
}

export function buildApp(cfg: AppConfig): { app: FastifyInstance; deps: AppDeps } {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 })
  const tmux = new Tmux(cfg.tmuxSocket ?? '')
  const workmux = new Workmux()
  const discovery = new Discovery(cfg, tmux, workmux)
  const input = new InputService(cfg, tmux, discovery)
  const operations = new Operations()
  const management = new Management(cfg, tmux, workmux, discovery, operations)
  const terminals = new TerminalHub(cfg, tmux, discovery)
  const deps: AppDeps = { cfg, tmux, workmux, discovery, input, management, operations, terminals }

  app.register(fastifyWebsocket, { options: { maxPayload: BOUNDS.maxWsMessageBytes } })

  app.addHook('onSend', (_req, reply, payload, done) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'no-referrer')
    done(null, payload)
  })

  // Uncaught ZodErrors (query/param .parse) must surface as the documented
  // 400 invalid_request contract, never as a 500 with internal detail.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'invalid_request',
        detail: err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).slice(0, 5).join('; '),
      })
    }
    if (err instanceof Error && 'validation' in err && (err as unknown as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: 'invalid_request', detail: err.message })
    }
    return reply.code(500).send({ error: 'internal_error' })
  })

  app.addHook('preHandler', async (req, reply) => {
    // Classify by the router-resolved pattern, never the raw URL: percent-
    // encoded prefixes (/%61pi/…) route into /api handlers while req.url
    // stays undecoded, which let them skip Host/Origin/header validation.
    const routed = req.routeOptions?.url ?? ''
    if (!routed.startsWith('/api/') && !req.url.startsWith('/api/')) return
    const verdict = checkRequest(req, cfg)
    if (!verdict.ok) {
      await reply.code(verdict.status ?? 403).send({ error: verdict.error })
    }
  })

  app.get('/api/health', async (): Promise<unknown> => {
    const checkedAt = Date.now()
    if (cfg.fixtureDir) {
      return {
        ok: true,
        workmuxVersion: 'fixture',
        tmuxSocket: null,
        tmuxReachable: true,
        workmuxReachable: true,
        fixtureMode: true,
        ownedTerminalSessions: terminals.ownedSessionNames(),
        checkedAt,
      }
    }
    const version = await workmux.version()
    const reachable = await tmux.ping()
    return {
      ok: version !== null && reachable,
      workmuxVersion: version,
      tmuxSocket: cfg.tmuxSocket,
      tmuxReachable: reachable,
      workmuxReachable: version !== null,
      fixtureMode: false,
      ownedTerminalSessions: terminals.ownedSessionNames(),
      checkedAt,
      ...(version === null ? { error: 'workmux not found on PATH' } : {}),
    }
  })

  app.get('/api/dashboard', async (req, reply) => {
    const query = DashboardQuery.parse(req.query)
    try {
      return await discovery.snapshot(query.force === '1')
    } catch (err) {
      return dependencyReply(reply, err)
    }
  })

  app.get('/api/projects', async () => discovery.projects())

  app.get('/api/agents/:id/output', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const { lines } = OutputQuery.parse(req.query)
    const targets = await discovery.agentTargets()
    if (!targets.has(id)) {
      return reply.code(404).send({ error: 'target_not_managed' })
    }
    try {
      if (cfg.fixtureDir) {
        const safe = id.replace(/[^%A-Za-z0-9_-]/g, '')
        const file = path.join(cfg.fixtureDir, `output-${safe}.txt`)
        const text = await fs.promises.readFile(file, 'utf8')
        return { paneId: id, text: text.replace(/\s+$/, ''), lines, truncated: false, observedAt: Date.now() }
      }
      const text = await tmux.capturePane(id, lines)
      return {
        paneId: id,
        text,
        lines,
        truncated: lines >= BOUNDS.maxOutputLines,
        observedAt: Date.now(),
      }
    } catch (err) {
      return reply.code(410).send({ error: 'target_gone', detail: errorMessage(err) })
    }
  })

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const parsed = MessageBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    try {
      return await input.message(id, parsed.data.text, parsed.data.requestId)
    } catch (err) {
      return inputReply(reply, err)
    }
  })

  app.post('/api/agents/:id/keys', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const parsed = KeysBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    try {
      return await input.keys(id, parsed.data.keys, parsed.data.requestId)
    } catch (err) {
      return inputReply(reply, err)
    }
  })

  app.get('/api/worktrees/:id/diff', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const { mode } = DiffQuery.parse(req.query)
    try {
      return await management.diff(id, mode)
    } catch (err) {
      return mgmtReply(reply, err)
    }
  })

  app.post('/api/worktrees/:id/hunks/:action', async (req, reply) => {
    const params = HunkParams.safeParse(req.params)
    if (!params.success) return reply.code(400).send({ error: 'unknown_hunk_action' })
    const { id, action } = params.data
    const parsed = HunkBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    try {
      return await management.hunkAction(id, action, parsed.data)
    } catch (err) {
      return mgmtReply(reply, err)
    }
  })

  app.post('/api/worktrees/:id/add', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const parsed = AddBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    try {
      return await management.addPending(id, parsed.data.paths)
    } catch (err) {
      return mgmtReply(reply, err)
    }
  })

  app.post('/api/worktrees/:id/commit', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const parsed = CommitBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    try {
      const op = await management.commitWorktree(id, parsed.data.message ?? '')
      return reply.code(202).send({ operationId: op.id })
    } catch (err) {
      return mgmtReply(reply, err)
    }
  })

  app.post('/api/worktrees/:id/hunk-comments', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const parsed = HunkCommentBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    let composed
    try {
      composed = await management.hunkComment(id, parsed.data)
    } catch (err) {
      return mgmtReply(reply, err)
    }
    if (!composed) return reply.code(409).send({ error: 'snapshot_stale', message: 'reload diff and retry' })
    const agents = (await discovery.snapshot()).agents.filter((a) => a.worktreeId === id)
    const wanted = parsed.data.agentId
    const agent = wanted ? agents.find((a) => a.id === wanted) : agents.length === 1 ? agents[0] : undefined
    if (!agent) {
      return reply.code(agents.length > 1 ? 409 : 404).send({
        error: agents.length > 1 ? 'ambiguous_agent' : 'no_agent_for_worktree',
      })
    }
    const requestId = `hc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    try {
      return await input.message(agent.id, composed.text, requestId)
    } catch (err) {
      return inputReply(reply, err)
    }
  })

  app.post('/api/worktrees', async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    try {
      return reply.code(202).send(await management.create(parsed.data))
    } catch (err) {
      return mgmtReply(reply, err)
    }
  })

  app.post('/api/actions/prepare', async (req, reply) => {
    const parsed = PrepareBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    try {
      return await management.prepare(parsed.data)
    } catch (err) {
      return mgmtReply(reply, err)
    }
  })

  app.post('/api/actions/execute', async (req, reply) => {
    const parsed = ExecuteBody.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request', detail: parsed.error.issues[0]?.message })
    try {
      return reply.code(202).send(await management.execute(parsed.data))
    } catch (err) {
      return mgmtReply(reply, err)
    }
  })

  app.get('/api/operations/:id', async (req, reply) => {
    const { id } = IdParams.parse(req.params)
    const op = operations.get(id)
    if (!op) return reply.code(404).send({ error: 'operation_not_found' })
    return op
  })

  app.register(async (scope) => {
    scope.get('/api/terminal', { websocket: true }, (socket, req) => {
      const verdict = checkRequest(req, cfg, { upgrade: true })
      if (!verdict.ok) {
        socket.send(JSON.stringify({ type: 'error', error: verdict.error }))
        socket.close()
        return
      }
      socket.on('message', (raw: Buffer) => {
        if (raw.length > BOUNDS.maxWsMessageBytes) return
        let text: string
        try {
          text = raw.toString('utf8')
        } catch {
          return
        }
        let data: unknown
        try {
          data = JSON.parse(text)
        } catch {
          return
        }
        const parsed = TerminalClientMessage.safeParse(data)
        if (!parsed.success) return
        void terminals.handle(socket, parsed.data)
      })
      socket.on('close', () => terminals.close(socket))
      socket.on('error', () => terminals.close(socket))
    })
  })

  // Resolve the built frontend at startup AND per-request so a server started
  // before `npm run build` still serves the SPA once the build exists.
  const publicDirCandidates = [
    path.join(import.meta.dirname, '..', 'public'),
    path.join(process.cwd(), 'dist', 'public'),
    path.join(process.cwd(), 'public'),
  ]
  const findIndexHtml = (): string | null => {
    for (const dir of publicDirCandidates) {
      const file = path.join(dir, 'index.html')
      if (fs.existsSync(file)) return file
    }
    return null
  }
  const initialPublic = findIndexHtml()
  // HTML must never be cached: assets are content-hashed (safe to keep
  // forever), index.html is not — a stale index.html pins a stale bundle.
  // no-store also keeps Safari out of bfcache for the document, which used
  // to resume the SPA with suspended poll loops.
  app.addHook('onSend', (req, reply, payload, done) => {
    const ct = String(reply.getHeader('content-type') ?? '')
    if (ct.includes('text/html')) {
      reply.header('cache-control', 'no-store, no-cache, must-revalidate')
      reply.header('pragma', 'no-cache')
      reply.header('expires', '0')
    }
    done()
  })
  if (initialPublic) {
    app.register(fastifyStatic, { root: path.dirname(initialPublic), maxAge: '1y', immutable: true })
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'not_found' })
      return
    }
    const index = findIndexHtml()
    if (!index) {
      reply.code(503).type('text/plain').send('Frontend not built yet. Run: npm run build')
      return
    }
    if (!initialPublic) {
      // Built after startup: read directly (fastify-static wasn't registered).
      reply
        .header('cache-control', 'no-store, no-cache, must-revalidate')
        .header('pragma', 'no-cache')
        .header('expires', '0')
        .type('text/html')
        .send(fs.readFileSync(index))
      return
    }
    reply.sendFile('index.html')
  })

  return { app, deps }
}

function dependencyReply(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof DependencyError) {
    return reply.code(502).send({ error: 'dependency_error', detail: err.message })
  }
  return reply.code(500).send({ error: 'internal', detail: errorMessage(err) })
}

function inputReply(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof TargetGoneError) return reply.code(410).send({ error: 'target_gone', detail: err.message })
  if (err instanceof UnknownDeliveryError) {
    return reply.code(502).send({
      error: 'delivery_unknown',
      requestId: err.requestId,
      paneId: err.paneId,
      detail: err.message,
    })
  }
  return dependencyReply(reply, err)
}

function mgmtReply(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof TargetNotFoundError) return reply.code(404).send({ error: 'target_not_found', detail: err.message })
  if (err instanceof BadRequestError) return reply.code(400).send({ error: 'bad_request', detail: err.message })
  if (err instanceof ConfirmationError) return reply.code(409).send({ error: 'confirmation_required', detail: err.message })
  return dependencyReply(reply, err)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const cfg = loadConfig()
  if (!cfg.fixtureDir && !cfg.tmuxSocket) {
    cfg.tmuxSocket = await Tmux.resolveDefaultSocket()
  }
  const { app, deps } = buildApp(cfg)
  app.listen({ host: cfg.bind, port: cfg.port }).then(async () => {
    process.stdout.write(`workmux-http listening on http://${cfg.bind}:${cfg.port}\n`)
    if (cfg.fixtureDir) process.stdout.write(`fixture mode: ${cfg.fixtureDir}\n`)
    if (cfg.allowAnyHost) {
      process.stderr.write(
        'WARNING: WORKMUX_ALLOWED_HOSTS=* accepts any Host header. There is no login, and ' +
          'DNS-rebinding from any reachable web page can drive your agents. ' +
          'Enumerate hosts instead unless this network is fully trusted.\n',
      )
    }
    await deps.terminals.sweepOrphans()
  }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `Port ${cfg.port} is already in use — another workmux-http instance is running ` +
          `(stop it first, or set WORKMUX_HTTP_PORT to a different port).\n`,
      )
    } else {
      process.stderr.write(`Failed to listen on ${cfg.bind}:${cfg.port}: ${err.message}\n`)
    }
    process.exit(1)
  })
}
