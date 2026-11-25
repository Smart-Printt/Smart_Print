# SmartPrint printer agent

A small program for the **print shop's PC**. It takes the next paid order of
its shop from SmartPrint, prints it with the order's settings, and marks it
**READY** (which tells the student their print is ready).

No extra packages: it only needs **Node.js 20.6 or newer**.

## Set up (once)

1. Install Node.js (LTS) on the shop PC.
2. Printing tool:
   - **Windows:** install [SumatraPDF](https://www.sumatrapdfreader.org) (free).
   - **Linux / macOS:** nothing to install — it uses the built-in `lp` command.
3. Ask the admin for a **shop staff account** for this shop (a separate one,
   e.g. `printer.gblock@…`, is best).
4. In this folder: copy `agent.env.example` to `agent.env` and fill it in
   (site address, that account, printer name).

## Run

```bash
npm start
```

Keeps running and prints orders as they arrive (checks every 10 seconds).
Stop with Ctrl+C.

**One-click print** (the plan's fallback): `npm run once` prints just the next
order and stops. Put it in a desktop shortcut and staff press it when they are
ready for the next job.

**Without a printer** (demo/testing): set `PRINT_METHOD=folder`. Each file is
saved to `OUTPUT_DIR` with the order code and settings in its name, e.g.
`SP-AB12_1_2x_BW_A4_DOUBLE.pdf`.

## What it does for each order

1. "Start next" — the same as the staff button; the order becomes PRINTING.
2. Downloads each file. Word/Excel/PowerPoint come as the PDF made on upload.
3. Prints each file: copies, black & white / colour, single / double sided,
   paper size and page range are passed to the printer.
4. Marks the order READY.

## When something goes wrong

- Downloads, printing and "mark ready" are each tried 3 times.
- If a file still cannot be printed (printer off, or a file that is not a PDF
  or image), the order **stays PRINTING** and the agent prints a message.
  Print it by hand and press **Mark ready** in the staff screen. Only one
  order prints per shop at a time, so the agent waits until then.
- Lost connection: it keeps trying every few seconds.

## Tests

```bash
npm test
```
