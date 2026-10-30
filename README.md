# Who is the fastest?

A single-page, no-backend visualisation that answers one question for any chosen
Formula 1 race: **which of two drivers was faster, and where?**

Pick a race and two drivers. The circuit is drawn segment by segment; each
segment is coloured in the team colour of the driver who covered that part of
the lap in less time. Hover a segment to see the time delta. The page is plain
HTML, CSS and JavaScript and reads pre-built JSON files, so it can be opened
from any static file server.

> Status: **in development**. See [`docs/`](docs/) for the data-source
> assessment, steering-board decisions, implementation plan and manuals.

## Quick start

```bash
npm run dev        # serve the page at http://localhost:5173
npm run build:data # rebuild data/ from the OpenF1 API (network required)
npm test           # unit + integration tests
```

No API key is required. Data comes from [OpenF1](https://openf1.org/), an
unofficial, community-run Formula 1 API. This personal project is not
affiliated with Formula 1.

## Documentation

- [Documentation index](docs/README.md)
- [User guide](docs/manuals/user-guide.md)
- [Data pipeline manual](docs/manuals/data-pipeline.md)
- [Architecture](docs/manuals/architecture.md)

## Licence / data notice

Source code is provided for personal, non-commercial use. Formula 1 data and
trademarks belong to their respective owners; OpenF1 is an unofficial project.
