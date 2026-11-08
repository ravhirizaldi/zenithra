import blessed from 'blessed';
import {
  consoleColour,
  consoleRequestState,
  formatConsoleRequest,
  formatServerBanner,
  printConsoleRequest,
  type ConsoleRequest,
} from './server-console.js';

export interface ServerConsole {
  start(origin: string): void;
  request(entry: ConsoleRequest): void;
  stop(): void;
}

export type DashboardTab = 'All' | 'Manager' | 'Client' | 'API Request';
type DashboardEntry = ConsoleRequest | 'info' | 'warn' | 'error';

export function dashboardEntryMatches(entry: DashboardEntry, tab: DashboardTab, errorsOnly: boolean): boolean {
  if (typeof entry === 'string') return tab === 'All' && (!errorsOnly || entry !== 'info');
  const path = entry.path.split('?')[0].toLowerCase();
  const within = (base: string) => path === base || path.startsWith(base + '/');
  const matchesTab =
    tab === 'All' ||
    (tab === 'Manager' && within('/conmasmanager')) ||
    (tab === 'API Request' && within('/conmasapi')) ||
    (tab === 'Client' && within('/conmasweb'));
  const state = consoleRequestState(entry);
  return matchesTab && (!errorsOnly || state === 'WARN' || state === 'FAIL' || state === 'ABORT');
}

export function supportsDashboard(): boolean {
  return Boolean(
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    consoleColour() &&
    (process.stdout.columns || 0) >= 60 &&
    (process.stdout.rows || 0) >= 18,
  );
}

// Keep the alternate screen optional: pipes, small terminals and NO_COLOR retain normal scrollback.
export function createServerConsole(): ServerConsole {
  let dashboard: ReturnType<typeof createDashboard> | undefined;
  let restoreConsole = () => {};
  return {
    start(origin) {
      if (supportsDashboard()) {
        try {
          dashboard = createDashboard(origin, undefined, () => {
            restoreConsole();
            dashboard = undefined;
          });
          const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
          // Route legacy console calls without exposing their error messages, SQL or data.
          const handlers = {
            log: () => dashboard?.notice('info'),
            info: () => dashboard?.notice('info'),
            warn: () => dashboard?.notice('warn'),
            error: () => dashboard?.notice('error'),
          };
          Object.assign(console, handlers);
          restoreConsole = () => {
            for (const name of ['log', 'info', 'warn', 'error'] as const)
              if (console[name] === handlers[name]) console[name] = original[name];
          };
          return;
        } catch {
          dashboard?.stop();
        }
      }
      console.log(formatServerBanner(origin));
    },
    request(entry) {
      if (dashboard) {
        try {
          dashboard.request(entry);
          return;
        } catch {
          dashboard.stop();
          dashboard = undefined;
        }
      }
      printConsoleRequest(entry);
    },
    stop() {
      dashboard?.stop();
      dashboard = undefined;
    },
  };
}

export function createDashboard(
  origin: string,
  screen = blessed.screen({
    smartCSR: true,
    fullUnicode: false,
    warnings: false,
    title: 'ZENITHRA SERVER | Server Console',
  }),
  onStop = () => {},
): Omit<ServerConsole, 'start'> & { notice(level: 'info' | 'warn' | 'error'): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const started = Date.now(),
      history: DashboardEntry[] = [];
    const traffic = Array.from({ length: 24 }, () => ({ second: -1, count: 0 }));
    const glyphs: Record<string, string[]> = {
      Z: ['#####', '   # ', '  #  ', ' #   ', '#####'],
      N: ['#   #', '##  #', '# # #', '#  ##', '#   #'],
      I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
      T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
      H: ['#   #', '#   #', '#####', '#   #', '#   #'],
      R: ['#### ', '#   #', '#### ', '# #  ', '#  ##'],
      E: ['#####', '#    ', '#### ', '#    ', '#####'],
      K: ['#   #', '#  # ', '###  ', '#  # ', '#   #'],
      A: [' ### ', '#   #', '#####', '#   #', '#   #'],
      V: ['#   #', '#   #', '#   #', ' # # ', '  #  '],
      S: [' ####', '#    ', ' ### ', '    #', '#### '],
    };
    const wordmark = Array.from({ length: 5 }, (_, row) =>
      ['ZENITHRA', 'SERVER'].map((word) => [...word].map((letter) => glyphs[letter][row]).join(' ')).join('    '),
    );
    let lastResult: { state: ReturnType<typeof consoleRequestState>; time: number } | undefined;
    let motion = true,
      following = true,
      stopped = false,
      notified = false,
      dirty = false;
    let activeTab: DashboardTab = 'All',
      errorsOnly = false;
    const notifyStop = () => {
      if (!notified) {
        notified = true;
        onStop();
      }
    };
    const counts = { requests: 0, saved: 0, warnings: 0, failures: 0 };
    const header = blessed.box({
      parent: screen,
      top: 0,
      left: 'center',
      width: '100%',
      height: 9,
      border: { type: 'line' },
      padding: { left: 1, right: 1 },
      tags: false,
      style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } },
    });
    const logs = blessed.box({
      parent: screen,
      top: 9,
      bottom: 3,
      width: '100%',
      label: ' LIVE REQUESTS / UTC ',
      border: { type: 'line' },
      tags: false,
      padding: { left: 1, right: 1 },
      scrollable: true,
      alwaysScroll: true,
      keys: false,
      mouse: true,
      scrollbar: { ch: ' ', style: { bg: 'cyan' } },
      style: { border: { fg: 'cyan' } },
    });
    const footer = blessed.box({
      parent: screen,
      bottom: 0,
      width: '100%',
      height: 3,
      tags: false,
      style: { fg: 'white' },
    });
    const controls = [' UP ', ' DOWN ', ' LIVE / End ', ' MOTION / A '].map((content, index) =>
      blessed.button({
        parent: footer,
        top: 1,
        height: 1,
        content,
        align: 'center',
        mouse: true,
        keys: true,
        style: {
          fg: 'white',
          bg: ['blue', 'blue', 'green', 'magenta'][index],
          hover: { fg: 'black', bg: 'cyan' },
          focus: { fg: 'black', bg: 'cyan' },
        },
      }),
    );
    const tabsBar = blessed.box({ parent: screen, top: 9, width: '100%', height: 1, style: { bg: 'black' } });
    const tabNames: DashboardTab[] = ['All', 'Manager', 'Client', 'API Request'];
    const tabColours = ['blue', 'cyan', 'magenta', 'yellow'];
    const tabHits = tabNames.map(() => 0);
    const tabButtons = tabNames.map((name, index) =>
      blessed.button({
        parent: tabsBar,
        height: 1,
        content: `${index + 1} ${name}`,
        align: 'center',
        mouse: true,
        keys: true,
        style: { fg: 'white', bg: 'blue', hover: { underline: true }, focus: { underline: true } },
      }),
    );
    const errorsStatus = blessed.box({
      parent: tabsBar,
      height: 1,
      align: 'center',
      mouse: false,
      keys: false,
      style: { fg: 'white', bg: 'black' },
    });
    const ansi = (text: string, colour: number) => `\x1b[${colour}m${text}\x1b[0m`;
    const clamp = (text: string, width: number) =>
      width <= 0 ? '' : text.length > width ? text.slice(0, width - 1) + '~' : text;
    const centered = (text: string, width: number) =>
      ' '.repeat(Math.max(0, Math.floor((width - text.length) / 2))) + text;
    const drawHeader = () => {
      const width = Math.max(8, Number(screen.width) - 4);
      const now = Date.now(),
        elapsed = now - started,
        seconds = Math.floor(elapsed / 1000);
      const uptime = `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ${seconds % 60}s`;
      const frame = Math.floor(elapsed / 180),
        pulse = motion ? ['/', '-', '\\', '|'][frame % 4] : '-';
      const title = 'ZENITHRA SERVER';
      const band = (parts: [string, number][], size = width, background = 40) => {
        const text = parts.map(([text]) => text).join('');
        if (text.length > size) return `\x1b[${background}m` + ansi(centered(clamp(text, size), size), parts[0][1]);
        const left = Math.floor((size - text.length) / 2);
        return (
          `\x1b[${background}m` +
          ' '.repeat(left) +
          parts.map(([text, colour]) => `\x1b[1;${colour}m${text}`).join('') +
          ' '.repeat(size - left - text.length) +
          '\x1b[0m'
        );
      };
      const compact = Number(screen.height) < 22 || Number(screen.width) < 80;
      const expanded = Number(screen.height) >= 34 && Number(screen.width) >= 100;
      header.height = compact ? 8 : expanded ? 15 : 10;
      tabsBar.top = Number(header.height);
      logs.top = Number(tabsBar.top) + 1;
      const second = Math.floor(now / 1000);
      const bins = Array.from({ length: 24 }, (_, index) => {
        const time = second - 23 + index,
          bucket = traffic[((time % traffic.length) + traffic.length) % traffic.length];
        return bucket.second === time ? bucket.count : 0;
      });
      const rate = (bins.slice(-5).reduce((total, count) => total + count, 0) / 5).toFixed(1);
      const levels = ' .:-=+*#';
      const activity = bins
        .map((count) => levels[Math.min(levels.length - 1, Math.ceil(Math.log2(count + 1)))])
        .join('');
      const lastTone =
        lastResult?.state === 'WARN' ? 93 : lastResult?.state === 'FAIL' || lastResult?.state === 'ABORT' ? 91 : 92;
      const result = lastResult
        ? `${lastResult.state}${lastResult.state === 'SAVED' ? ' / COMMITTED' : ''}  /  ${Math.max(0, Math.floor((now - lastResult.time) / 1000))}s ago`
        : 'WAITING FOR FIRST REQUEST';
      const highlight = motion && lastResult && now - lastResult.time < 1800 && lastResult.state !== 'OK';
      header.style.border.fg = highlight ? (lastTone === 91 ? 'red' : lastTone === 93 ? 'yellow' : 'green') : 'cyan';
      const columnWidth = Math.floor((width - 3) / 2);
      const columnWidths = [columnWidth, width - 3 - columnWidth];
      const columnRow = (cells: [string, number][], heading = false) =>
        cells
          .map(([text, colour], index) => {
            const size = columnWidths[index],
              content = clamp(text, size - 2);
            const padded = heading ? centered(content, size).padEnd(size) : ' ' + content.padEnd(size - 2) + ' ';
            return `\x1b[${heading ? 44 : 40};${heading ? '1;' : ''}${colour}m${padded}\x1b[0m`;
          })
          .join(ansi(' | ', 94));
      const metric = (label: string, value: string) => {
        const size = Math.max(0, columnWidths[1] - 2),
          number = clamp(value, size);
        return clamp(label, size - number.length - 1).padEnd(size - number.length) + number;
      };
      const trace = activity.slice(-Math.max(1, columnWidths[0] - 13));
      header.setContent(
        [
          band([[title, 97]], width, 41),
          ...(expanded ? wordmark.map((row) => band([[row, 97]], width, 41)) : []),
          columnRow(
            [
              ['SERVER INFORMATION', 97],
              ['REQUEST ACTIVITY', 97],
            ],
            true,
          ),
          columnRow([
            [`ONLINE ${pulse}`, 92],
            [metric('REQUESTS', String(counts.requests)), 96],
          ]),
          columnRow([
            [`UPTIME ${uptime}`, 96],
            [metric('SAVED', String(counts.saved)), 92],
          ]),
          columnRow([
            [`NODE ${process.versions.node}${compact ? '' : ` / PID ${process.pid}`}`, 93],
            [metric('WARN', String(counts.warnings)), 93],
          ]),
          columnRow([
            [origin, 97],
            [metric('FAIL', String(counts.failures)), 91],
          ]),
          ...(!compact
            ? [
                columnRow([
                  [`TRAFFIC [${trace}]`, 96],
                  [metric('REQ/S (5s)', rate), 96],
                ]),
                band(
                  [
                    ['LAST RESULT  ', 37],
                    [result, lastTone],
                  ],
                  width,
                  highlight ? 44 : 40,
                ),
              ]
            : []),
        ].join('\n'),
      );
      const footerWidth = Math.max(8, Number(screen.width));
      const filterWidth = compact ? 16 : 22;
      const tabLabels = tabNames.map((name) =>
        name === 'Client' && footerWidth >= 100
          ? 'Client (Editor and Designer)'
          : name === 'API Request' && footerWidth < 70
            ? 'API Req'
            : name,
      );
      const tabWidths = tabLabels.map((label) => label.length + 4);
      const extraWidth = Math.max(
        0,
        Math.floor((footerWidth - filterWidth - 4 - tabWidths.reduce((total, size) => total + size, 0)) / 4),
      );
      let tabLeft = 0;
      tabButtons.forEach((button, index) => {
        const selected = activeTab === tabNames[index],
          hit = motion && now - tabHits[index] < 900;
        const flash = hit && Math.floor((now - tabHits[index]) / 180) % 2 === 0;
        button.left = tabLeft;
        button.width = tabWidths[index] + extraWidth;
        tabLeft += Number(button.width) + 1;
        button.setContent(`${index + 1} ${tabLabels[index]}${hit ? ' *' : '  '}`);
        button.style.bg = flash ? 'white' : selected ? tabColours[index] : 'black';
        button.style.fg = flash ? 'black' : !selected ? tabColours[index] : index === 0 ? 'white' : 'black';
        button.style.bold = selected || hit;
        button.style.underline = selected;
      });
      errorsStatus.left = tabLeft;
      errorsStatus.width = Math.max(1, footerWidth - tabLeft);
      errorsStatus.setContent(
        compact ? `E Errors: ${errorsOnly ? 'ON' : 'OFF'}` : `E Errors only: ${errorsOnly ? 'ON' : 'OFF'}`,
      );
      errorsStatus.style.fg = errorsOnly ? 'yellow' : 'white';
      footer.setContent(
        band(
          [
            [following ? 'LIVE FOLLOW' : 'READING HISTORY', following ? 92 : 93],
            ['  |  ', 94],
            [motion ? 'ANIMATION ON' : 'ANIMATION OFF', 96],
            ['  |  ', 94],
            ['Credit: Ravhi Rizaldi', 95],
          ],
          footerWidth,
        ) +
          '\n\n' +
          centered(
            clamp(
              compact
                ? 'Wheel: scroll  Shift+drag: copy  Ctrl+C: stop'
                : 'Wheel / scrollbar: scroll  Shift+drag: select  PgUp/PgDn: page  Ctrl+C: stop',
              footerWidth,
            ),
            footerWidth,
          ),
      );
      const controlWidth = Math.floor(Math.min(64, footerWidth - 2) / 4),
        controlLeft = Math.floor((footerWidth - controlWidth * 4) / 2);
      controls.forEach((control, index) => {
        control.left = controlLeft + index * controlWidth;
        control.width = controlWidth - 1;
      });
      controls[3].setContent(motion ? ' ANIM ON / A ' : ' ANIM OFF / A ');
    };
    const logText = (entry: DashboardEntry) => {
      if (typeof entry === 'string')
        return ansi(
          `SERVER ${entry.toUpperCase()} / Diagnostic emitted; raw details withheld. Check request JSONL.`,
          entry === 'error' ? 31 : entry === 'warn' ? 33 : 36,
        );
      const state = consoleRequestState(entry),
        colour = state === 'FAIL' || state === 'ABORT' ? 31 : state === 'WARN' ? 33 : 32;
      const width = Math.max(24, Number(screen.width) - 1);
      return formatConsoleRequest(entry, width, false)
        .split('\n')
        .filter(Boolean)
        .map((line, index) => ansi(line.slice(2, -2).trimEnd(), index ? 90 : colour))
        .join('\n');
    };
    const rebuildLogs = () => {
      const scroll = logs.getScroll();
      logs.setContent(
        history
          .filter((entry) => dashboardEntryMatches(entry, activeTab, errorsOnly))
          .map(logText)
          .filter(Boolean)
          .join('\n') ||
          ansi(
            history.length
              ? 'No matching activity in the latest 500 events.'
              : 'Waiting for requests. The banner stays here; only this area scrolls.',
            90,
          ),
      );
      logs.setLabel(` LIVE REQUESTS / UTC / ${activeTab.toUpperCase()}${errorsOnly ? ' / ERRORS ONLY' : ''} `);
      if (following) logs.setScrollPerc(100);
      else logs.setScroll(scroll);
    };
    const draw = () => {
      if (stopped) return;
      try {
        if (dirty) {
          rebuildLogs();
          dirty = false;
        }
        drawHeader();
        screen.render();
      } catch {
        stop();
      }
    };
    const scroll = (amount: number) => {
      following = false;
      logs.scroll(amount);
      draw();
    };
    const live = () => {
      following = true;
      logs.setScrollPerc(100);
      draw();
    };
    const toggleMotion = () => {
      motion = !motion;
      draw();
    };
    const selectTab = (tab: DashboardTab) => {
      activeTab = tab;
      following = true;
      dirty = true;
      draw();
    };
    const toggleErrors = () => {
      errorsOnly = !errorsOnly;
      following = true;
      dirty = true;
      draw();
    };
    tabButtons.forEach((button, index) => {
      button.on('press', () => selectTab(tabNames[index]));
      screen.key([String(index + 1)], () => selectTab(tabNames[index]));
    });
    screen.key(['e', 'E'], toggleErrors);
    controls[0].on('press', () => scroll(-3));
    controls[1].on('press', () => scroll(3));
    controls[2].on('press', live);
    controls[3].on('press', toggleMotion);
    for (const event of ['wheelup', 'wheeldown', 'mousedown'])
      logs.on(event, () => {
        following = false;
        draw();
      });
    screen.key(['up', 'k'], () => scroll(-1));
    screen.key(['down', 'j'], () => scroll(1));
    screen.key(['pageup'], () => scroll(-Math.max(1, Number(logs.height) - 3)));
    screen.key(['pagedown'], () => scroll(Math.max(1, Number(logs.height) - 3)));
    screen.key(['home'], () => {
      following = false;
      logs.setScroll(0);
      draw();
    });
    screen.key(['end'], live);
    screen.key(['a', 'A'], toggleMotion);
    // shortcut: exits only this server; press Ctrl+C again if the parent watcher remains.
    screen.key(['C-c'], () => {
      stop();
      process.exit(130);
    });
    screen.on('resize', () => {
      try {
        drawHeader();
        dirty = true;
        draw();
      } catch {
        stop();
      }
    });
    function stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        screen.destroy();
      } finally {
        notifyStop();
      }
    }
    screen.on('destroy', () => {
      stopped = true;
      clearInterval(timer);
      notifyStop();
    });
    timer = setInterval(draw, 180);
    timer.unref();
    drawHeader();
    rebuildLogs();
    screen.render();
    return {
      stop,
      notice(level) {
        if (stopped) return;
        history.push(level);
        if (history.length > 500) history.shift();
        dirty = true;
      },
      request(entry) {
        if (stopped) return;
        try {
          counts.requests++;
          const state = consoleRequestState(entry);
          const now = Date.now(),
            second = Math.floor(now / 1000),
            bucket = traffic[second % traffic.length];
          if (bucket.second !== second) {
            bucket.second = second;
            bucket.count = 0;
          }
          bucket.count++;
          lastResult = { state, time: now };
          tabNames.forEach((tab, index) => {
            if (dashboardEntryMatches(entry, tab, false)) tabHits[index] = now;
          });
          if (state === 'SAVED') counts.saved++;
          if (state === 'WARN') counts.warnings++;
          if (state === 'FAIL' || state === 'ABORT') counts.failures++;
          if (formatConsoleRequest(entry, 80, false)) {
            history.push(entry);
            if (history.length > 500) history.shift();
            dirty = true;
          }
        } catch {
          stop();
          printConsoleRequest(entry);
        }
      },
    };
  } catch (error) {
    clearInterval(timer);
    screen.destroy();
    throw error;
  }
}
