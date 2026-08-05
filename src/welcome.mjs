import path from 'node:path'
import readline from 'node:readline/promises'
import { VERSION } from './constants.mjs'

export const WELCOME_ACTIONS = Object.freeze([
  { id: 'create', label: 'Create a game', detail: 'Describe it, then let Orbit build and validate it' },
  { id: 'web', label: 'Open Web CLI', detail: 'Use the local browser interface' },
  { id: 'runs', label: 'View local runs', detail: 'Find a checkpoint to resume' },
  { id: 'auth', label: 'Sign in to Orbit', detail: 'Use Orbit Cloud with your account' },
  { id: 'providers', label: 'List providers', detail: 'See available and configured model providers' },
  { id: 'doctor', label: 'Run doctor', detail: 'Check this installation and account status' },
  { id: 'help', label: 'Show all commands', detail: 'Print the complete CLI reference' },
])

const RESET = '\u001b[0m'
const BOLD = '\u001b[1m'
const DIM = '\u001b[2m'
const INVERSE = '\u001b[7m'

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value))
}

function displayPath(cwd, home) {
  const absolute = path.resolve(cwd)
  if (home && (absolute === home || absolute.startsWith(`${home}${path.sep}`))) {
    return `~${absolute.slice(home.length)}`
  }
  return absolute
}

function visibleLength(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, '').length
}

function pad(value, width) {
  const text = String(value)
  return `${text}${' '.repeat(Math.max(0, width - visibleLength(text)))}`
}

function clip(value, width) {
  const text = String(value)
  if (text.length <= width) return text
  if (width <= 1) return '…'.slice(0, width)
  return `${text.slice(0, width - 1)}…`
}

function paint(value, code, color) {
  return color ? `${code}${value}${RESET}` : value
}

export function renderWelcomeScreen({
  cwd = process.cwd(),
  home = process.env.HOME,
  config = {},
  selectedIndex = 0,
  columns = 88,
  color = true,
} = {}) {
  const width = clamp(Number(columns) || 88, 68, 100)
  const contentWidth = width - 4
  const title = ` Orbit CLI v${VERSION} `
  const top = `┌─${title}${'─'.repeat(Math.max(0, width - title.length - 3))}┐`
  const bottom = `└${'─'.repeat(width - 2)}┘`
  const mode = config.mode === 'byok'
    ? `BYOK · ${config.provider || 'provider not selected'}`
    : 'Orbit Cloud'
  const runtime = config.runtime || 'html'
  const directory = clip(displayPath(cwd, home), contentWidth - 13)
  const boxLine = (value = '') => `│ ${pad(value, contentWidth)} │`
  const rows = [
    paint(top, DIM, color),
    boxLine(),
    boxLine(paint('Build playable browser games from your terminal.', BOLD, color)),
    boxLine(),
    boxLine(`mode       ${mode}`),
    boxLine(`runtime    ${runtime}`),
    boxLine(`directory  ${directory}`),
    boxLine(),
    paint(bottom, DIM, color),
    '',
    paint('What would you like to do?', BOLD, color),
    '',
  ]

  const labelWidth = 22
  for (const [index, action] of WELCOME_ACTIONS.entries()) {
    const active = index === selectedIndex
    const prefix = active ? '›' : ' '
    const detail = active ? action.detail : paint(action.detail, DIM, color)
    const line = `${prefix} ${pad(action.label, labelWidth)} ${detail}`
    rows.push(active ? paint(pad(line, width), INVERSE, color) : line)
  }

  rows.push('', paint('↑↓ navigate   enter select   1–7 shortcut   q quit', DIM, color))
  return rows.join('\n')
}

export function welcomeActionArguments(actionId) {
  if (actionId === 'web') return ['web']
  if (actionId === 'runs') return ['runs']
  if (actionId === 'auth') return ['auth', 'login']
  if (actionId === 'providers') return ['providers', 'list']
  if (actionId === 'doctor') return ['doctor']
  if (actionId === 'help') return ['help']
  return null
}

export async function collectCreateArguments({
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  ask,
} = {}) {
  const defaultWorkspace = path.join(cwd, 'orbit-game')
  let close = () => {}
  let question = ask
  if (!question) {
    const interface_ = readline.createInterface({ input: stdin, output: stdout })
    close = () => interface_.close()
    question = (message) => interface_.question(message)
  }
  try {
    const prompt = String(await question('\nDescribe the game you want to build\n› ')).trim()
    if (!prompt) return null
    const workspaceInput = String(await question(`Workspace [${defaultWorkspace}]\n› `)).trim()
    return ['generate', '--prompt', prompt, '--workspace', path.resolve(cwd, workspaceInput || defaultWorkspace)]
  } finally {
    close()
  }
}

export async function runWelcomeMenu({
  stdin = process.stdin,
  stdout = process.stdout,
  cwd = process.cwd(),
  home = process.env.HOME,
  config = {},
  color = !process.env.NO_COLOR && process.env.TERM !== 'dumb',
} = {}) {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') return null
  let selectedIndex = 0
  const render = () => {
    stdout.write(`\u001b[2J\u001b[H${renderWelcomeScreen({ cwd, home, config, selectedIndex, columns: stdout.columns, color })}\n`)
  }

  stdin.setRawMode(true)
  stdin.resume()
  stdout.write('\u001b[?25l')
  render()
  try {
    while (true) {
      const chunk = String(await new Promise((resolve) => stdin.once('data', resolve)))
      if (chunk === '\u0003' || chunk === 'q' || chunk === 'Q') return null
      if (chunk === '\r' || chunk === '\n') return WELCOME_ACTIONS[selectedIndex].id
      if (/^[1-7]$/.test(chunk)) return WELCOME_ACTIONS[Number(chunk) - 1].id
      if (chunk === '\u001b[A' || chunk === 'k' || chunk === 'K') {
        selectedIndex = (selectedIndex - 1 + WELCOME_ACTIONS.length) % WELCOME_ACTIONS.length
        render()
      } else if (chunk === '\u001b[B' || chunk === 'j' || chunk === 'J') {
        selectedIndex = (selectedIndex + 1) % WELCOME_ACTIONS.length
        render()
      }
    }
  } finally {
    stdin.setRawMode(false)
    stdin.pause()
    stdout.write('\u001b[?25h\u001b[2J\u001b[H')
  }
}
