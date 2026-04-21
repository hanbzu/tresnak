#!/usr/bin/env -S deno run --allow-run --allow-env

/**
 * Generates an ASCII candlestick chart of cumulative lines of code, one candle per week.
 *
 * Each candle shows whether there was activity that week, how much was added (wick above body),
 * how much was deleted (wick below body), and the net consolidation (body height and direction).
 *
 * The chart also tracks codebase growth over time. Growth has a cost — more code means more to
 * read, maintain, and understand — so the goal is deliberate expansion, not mindless accumulation.
 */

const LOC_PER_ROW = 500; // vertical resolution: one character row equals this many lines
const LABEL_INTERVAL = 2000; // Y axis labels appear at every multiple of this value
const WEEKS_PER_MONTH = 4.33; // approximation used to convert a week count to months for display
const DEFAULT_WEEKS = 26;
const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

const weeks = parseInt(Deno.args[0] ?? String(DEFAULT_WEEKS));
const useColor =
    !Deno.env.get("NO_COLOR") &&
    (Deno.stdout.isTerminal() ||
        !!Deno.env.get("FORCE_COLOR") ||
        Deno.env.get("CI") === "true");

/** Wraps text in an ANSI escape code when color output is enabled. */
function styled(text: string, code: string): string {
    return useColor ? `${code}${text}${RESET}` : text;
}

/** Formats a line count in k notation (e.g. 1500 → "1.5k", 2000 → "2k"). */
function fmtK(n: number): string {
    const k = n / 1000;
    // toFixed(1) can produce "15.0" when rounding, so strip the trailing .0
    return (
        (Number.isInteger(k)
            ? k.toString()
            : k.toFixed(1).replace(/\.0$/, "")) + "k"
    );
}

interface Week {
    date: string; // ISO Monday, e.g. "2024-10-07"
    adds: number;
    dels: number;
}

interface Candle {
    date: string;
    open: number;
    close: number;
    high: number;
    low: number;
}

/** Returns the ISO Monday (YYYY-MM-DD) for the week containing the given date. */
function isoMonday(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00Z");
    const day = d.getUTCDay();
    // Sunday (0) steps back 6 days; all other days step back to Monday
    d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
    return d.toISOString().slice(0, 10);
}

/** Returns the ISO Monday for the week that was n weeks ago. */
function mondayNWeeksAgo(n: number): string {
    const d = new Date();
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day) - n * 7);
    return d.toISOString().slice(0, 10);
}

/** Runs git log --numstat and returns additions and deletions aggregated per calendar week. */
async function fetchWeeklyStats(): Promise<Week[]> {
    const { stdout, success } = await new Deno.Command("git", {
        args: ["log", "--pretty=format:%ad", "--date=short", "--numstat"],
        stdout: "piped",
        stderr: "null",
    }).output();

    if (!success) {
        console.error(
            "git log failed – make sure you are inside a git repository.",
        );
        Deno.exit(1);
    }

    const byWeek = new Map<string, { adds: number; dels: number }>();
    let currentWeek = "";

    for (const line of new TextDecoder().decode(stdout).split("\n")) {
        const trimmed = line.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            currentWeek = isoMonday(trimmed);
            if (!byWeek.has(currentWeek))
                byWeek.set(currentWeek, { adds: 0, dels: 0 });
        } else if (currentWeek) {
            const m = trimmed.match(/^(\d+)\t(\d+)\t/);
            if (m) {
                byWeek.get(currentWeek)!.adds += parseInt(m[1]);
                byWeek.get(currentWeek)!.dels += parseInt(m[2]);
            }
        }
    }

    return [...byWeek.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, { adds, dels }]) => ({ date, adds, dels }));
}

/** Returns a dense array covering the last n weeks, with zeros for weeks with no commits. */
function fillWindow(data: Week[], n: number): Week[] {
    const byWeek = new Map(data.map((w) => [w.date, w]));
    return Array.from({ length: n }, (_, i) => {
        const date = mondayNWeeksAgo(n - 1 - i);
        return byWeek.get(date) ?? { date, adds: 0, dels: 0 };
    });
}

/** Converts per-week stats into OHLC candles, treating cumulative LOC as the price axis. */
function buildCandles(data: Week[], initialLoc = 0): Candle[] {
    let cum = initialLoc;
    return data.map(({ date, adds, dels }) => {
        const open = cum;
        const high = open + adds;
        const low = Math.max(0, open - dels); // LOC can't go negative
        const close = open + adds - dels;
        cum = close;
        return { date, open, close, high, low };
    });
}

/** Builds the month-label row for the X axis, placing 3-char names at month-start weeks. */
function buildMonthLabels(candles: Candle[]): string {
    const cells = new Array<string>(candles.length).fill(" ");
    for (let i = 0; i < candles.length; i++) {
        const monday = new Date(candles[i].date + "T00:00:00Z");
        // Scan all 7 days of the week to find if the 1st of a month falls within it
        for (let d = 0; d < 7; d++) {
            const day = new Date(monday);
            day.setUTCDate(monday.getUTCDate() + d);
            if (day.getUTCDate() === 1) {
                const label = MONTHS[day.getUTCMonth()];
                for (let j = 0; j < label.length && i + j < cells.length; j++)
                    cells[i + j] = label[j];
                break;
            }
        }
    }
    return cells.join("");
}

/** Renders the full candlestick chart to stdout. */
function render(candles: Candle[], totalAdds: number, totalDels: number): void {
    if (candles.length === 0) {
        console.log("No git history found.");
        return;
    }

    const months = Math.round(weeks / WEEKS_PER_MONTH);
    const high =
        Math.ceil(Math.max(...candles.map((c) => c.high)) / LABEL_INTERVAL) *
        LABEL_INTERVAL;
    const low =
        Math.floor(Math.min(...candles.map((c) => c.low)) / LABEL_INTERVAL) *
        LABEL_INTERVAL;
    const chartHeight = Math.max(1, (high - low) / LOC_PER_ROW);
    const labelWidth = Math.max(fmtK(high).length, fmtK(low).length) + 1;

    console.log(styled(`Lines of code weekly · last ${months} months`, BOLD));
    console.log();

    for (let row = 0; row < chartHeight; row++) {
        // Sample the vertical midpoint of each row to determine which part of the candle is visible
        const y = high - (row + 0.5) * LOC_PER_ROW;
        const rowLoc = Math.round(high - row * LOC_PER_ROW);
        const isLabelRow = rowLoc % LABEL_INTERVAL === 0;
        const label = isLabelRow
            ? fmtK(rowLoc).padStart(labelWidth)
            : " ".repeat(labelWidth);
        let line = styled(label, DIM) + " ";

        for (const candle of candles) {
            const bodyTop = Math.max(candle.open, candle.close);
            const bodyBottom = Math.min(candle.open, candle.close);
            const color = candle.close >= candle.open ? GREEN : RED;

            if (y >= bodyBottom && y <= bodyTop) {
                line += styled("█", color);
            } else if (
                (y > bodyTop && y <= candle.high) ||
                (y >= candle.low && y < bodyBottom)
            ) {
                line += "│";
            } else {
                line += isLabelRow ? styled("·", DIM) : " ";
            }
        }
        console.log(line);
    }

    console.log();
    console.log(
        styled(" ".repeat(labelWidth + 1) + buildMonthLabels(candles), DIM),
    );

    const currentLoc = candles.at(-1)!.close;
    const months_label = `on the last ${months} mo`;
    console.log();
    console.log(
        `Currently ${styled(fmtK(currentLoc) + " lines", BOLD)} ` +
            `(${styled("+" + fmtK(totalAdds), GREEN)} ${styled("-" + fmtK(totalDels), RED)} ${months_label})`,
    );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const allData = await fetchWeeklyStats();
const windowData = fillWindow(allData, weeks);

// Find cumulative LOC just before the window starts so candles are anchored to the right baseline
const windowStart = windowData[0].date;
const openingLoc = allData
    .filter((w) => w.date < windowStart)
    .reduce((sum, w) => sum + w.adds - w.dels, 0);

const windowCandles = buildCandles(windowData, openingLoc);
const totalAdds = windowData.reduce((s, w) => s + w.adds, 0);
const totalDels = windowData.reduce((s, w) => s + w.dels, 0);
render(windowCandles, totalAdds, totalDels);
