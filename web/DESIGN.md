# Design direction

## Product signal
- User: individual building and evaluating a local RAG system on macOS.
- Current scope: English desktop UI prototype; no inference, indexing, real evaluation or cloud service.
- Content mode: text-light, minimal sample data explicitly authorized by user.
- Primary reference: supplied 15.315-second smart-home UI video, inspected at 2-second intervals and full-resolution home frame at 8s.
- Preserve: slim white icon rail; horizontal workspace navigation; lavender canvas; status chips; 4 compact switches; 3 larger widgets; lower secondary cards. Avoid large marketing headings.

## Visual character
- A quiet, rounded workspace with black active controls and colored circular device-like accents.
- Typeface: local system sans, regular/medium, 12–14px labels, 18–22px section headings, tabular numbers.
- Canvas #efedf5; cards white; text #303137; muted #74717e; lilac, peach, citron, and cornflower accents.
- Radius: 16px cards, 28px outer frame, pill rail and switches. Borders nearly invisible, no heavy card shadows.
- Spacing: 12–18px card gaps, 28–38px content gutters, generous gap above the first status row.
- Reference temperature gauge becomes evaluation gauge; player becomes pipeline run preview; camera becomes an abstract retrieval field.
- Motion: staggered blur-to-clear entrances, 0.5–0.75s spring settling; exit before enter; shared black navigation indicator; switch knob springs; animated SVG score arc; sequential pipeline pulses; modal lift. Respect reduced motion.

## Interaction contracts
| Intent | Trigger | Feedback and result | Alternative |
|---|---|---|---|
| Navigate | Rail or top navigation | Active indicator moves, content exits then enters | Keyboard focus and Enter |
| Toggle sample stage | Switch | Knob moves and stage state changes | Space |
| Preview a run | Play | Sequential node highlighting; sample completion and activity entry | Button Enter |
| Inspect evaluation | Gauge / evaluate | Score and chart animate from seeded example | Keyboard button |
| Add knowledge base | Add dialog | Named sample collection appears | Form submit |
| Preview conversation | Submit prompt | Explicit demo response; session appears in conversations | Enter |
| Inspect pipeline | Node click | Node configuration panel | Tab and Enter |

## Deliberate exclusions
- No fabricated backend connectivity, real RAG results, file processing or production auth.
- No smart-home imagery, identity, profile photo or unrelated copy.
- Do not claim measured evaluation values; visible sample indicator and demo tags clarify content.

## Validation
- Primary: desktop browser, approximately 1440 × 1000.
- Constrained: 1024 × 768, no horizontal viewport overflow.
- Test navigation, switches, run progress, dialogs, collection creation, conversation flow, keyboard and reduced motion.
