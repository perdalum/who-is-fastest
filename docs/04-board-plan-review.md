# Steering-board review: implementation plan v1.1

- **Date:** 2026-10-30
- **Board:** same five roles as the data-source decision
- **Inputs:** [assessment v1.1](01-data-source-assessment.md),
  [decision record](02-steering-board-decision.md),
  [implementation plan v1.1](03-implementation-plan.md)
- **Question:** approve the plan, approve with minor edits, or require more work?

## 1. Result

> **APPROVED WITH MINOR EDITS — 5 of 5.** No member required a re-plan.

| Role | Vote | Key remaining edits |
| --- | --- | --- |
| Chair | APPROVE WITH MINOR EDITS | Size target wording, request count, tautology caveat, Monaco artifact, CEO scope note |
| Data Engineering | APPROVE WITH MINOR EDITS | 0.6 s gap rule / neutral bins, start-edge rule, sector tautology, named races, projection seam test |
| Frontend / UX | APPROVE WITH MINOR EDITS | Unit contract, ≥90 % neutral acceptance, all-pairs secondary encoding, in-UI method panel, visual gate, budget, butt caps |
| Quality & Risk | APPROVE WITH MINOR EDITS | Missing-bin rule, 0.03 s band, pre-scale integral check, build manifest metadata, line interpolation, round number |
| Product / Strategy | APPROVE WITH MINOR EDITS | Visible "best available laps" copy, telemetry-limited badge gate, CEO visual gate, usability check, tautology |

**For: 5. Against: 0. Re-plan required: 0.**

## 2. Edits folded into the plan before implementation

- Deadband raised to **0.03 s** (≈2σ); same-driver neutral acceptance ≥**90 %**.
- Uncovered/gap bins become `null` → neutral; gaps >0.6 s are never bridged;
  >15 % affected rejects the lap.
- Start-line position/speed interpolation and residual metadata added.
- Pre-scale speed integral (1–2 % short) validated separately; the scaled total
  is documented as official by construction.
- Manifest now includes build-script git SHA, request count/URLs, raw-cache
  checksums and as-of timestamp.
- `round` corrected to 18 for Austin (sequential non-cancelled Grands Prix).
- Unit contract explicit: `dt` is per 25 m; the client sums four bins per 100 m.
- All-pairs secondary encoding when colours are close, not just same team.
- In-UI methodology panel with source, lap rule, calibration, coverage and
  CC BY-NC-SA attribution.
- Bundle budget (<250 KB initial; <150 KB/race), butt caps/no overlap, glow via
  underlay.
- "Quicker on their best available laps" is primary copy; telemetry-limited
  badge + official best lap/time is a release gate with a fixture.
- CEO visual sign-off, five-minute usability check and the five-race scope note
  are in the acceptance criteria / definition of done.

## 3. Recorded dissent and limits

- The Quality & Risk member's earlier NO-GO trigger (no uncertainty encoding)
  is resolved by the 0.03 s band, neutral colour and methodology panel.
- The board still cannot visually inspect `IMG_1141.PNG`; CEO confirmation is a
  release gate, not something the board can waive.
- The CEO has not pre-approved the five-race scope cut. It is recorded as a
  reversible product decision and must be surfaced in the CEO report with the
  expansion command.

## 4. Authorisation

The board authorises implementation workstreams W1–W5 as specified in the plan,
subject to the edits in §2 (now applied). Independent testing (W6) starts only
after W5 produces the five-race dataset; release requires a clean test report and
CEO visual sign-off.
