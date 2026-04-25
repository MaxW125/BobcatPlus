# Rule-Shape Inventory

Generated 2026-04-25 from **83 audits** (83 fixture files).
Fixture root: `tests/fixtures/audits/`

Parser column: ✅ = handled by current `txstFromAudit.js`; ⚠️ = falls through to default/OTHER.

## Block `requirementType`

| Value | Audits | % audits | Occurrences | Parser |
| --- | --- | --- | --- | --- |
| `OTHER` | 83 | 100% | 275 | ✅ |
| `DEGREE` | 83 | 100% | 83 | ✅ |
| `MAJOR` | 80 | 96% | 80 | ✅ |
| `CONC` | 9 | 11% | 9 | ✅ |
| `MINOR` | 3 | 4% | 3 | ✅ |

## Rule `ruleType`

| Value | Audits | % audits | Occurrences | Parser |
| --- | --- | --- | --- | --- |
| `Course` | 83 | 100% | 2862 | ✅ |
| `Block` | 83 | 100% | 277 | ✅ |
| `Group` | 83 | 100% | 236 | ✅ |
| `Complete` | 83 | 100% | 193 | ✅ |
| `Subset` | 63 | 76% | 190 | ✅ |
| `Blocktype` | 83 | 100% | 149 | ✅ |
| `Incomplete` | 48 | 58% | 51 | ✅ |
| `Noncourse` | 4 | 5% | 6 | ✅ |

## `qualifierArray[].code`

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `MINGRADE` | 31 | 37% | 184 |
| `HIGHPRIORITY` | 56 | 67% | 171 |
| `LOWESTPRIORITY` | 68 | 82% | 89 |
| `NONEXCLUSIVE` | 36 | 43% | 59 |
| `EXCLUSIVE` | 26 | 31% | 36 |
| `MAXTERM` | 5 | 6% | 34 |
| `LOWPRIORITY` | 22 | 27% | 28 |
| `HIDERULE` | 12 | 14% | 24 |
| `NOTGPA` | 2 | 2% | 6 |
| `MINPERDISC` | 4 | 5% | 4 |

## `exceptionArray[].type`

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `RR` | 82 | 99% | 164 |
| `AA` | 82 | 99% | 84 |
| `NN` | 82 | 99% | 82 |
| `AH` | 82 | 99% | 82 |
| `FC` | 1 | 1% | 1 |

## Course array patterns

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `concrete` | 83 | 100% | 12367 |
| `attrWildcard` | 83 | 100% | 2900 |
| `subjectWildcard` | 50 | 60% | 366 |
| `attributePlaceholder` | 6 | 7% | 6 |

## `classCreditOperator` values

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `OR` | 83 | 100% | 2843 |
| `AND` | 19 | 23% | 19 |

## `connector` values

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `,` | 83 | 100% | 2519 |
| `+` | 26 | 31% | 304 |
| `OR` | 12 | 14% | 23 |
| `AND` | 6 | 7% | 16 |

## Structural flags

Presence counts — how many audits contain at least one instance.

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `hideFromAdvice:course` | 83 | 100% | 8142 |
| `withArray` | 83 | 100% | 2995 |
| `ifElsePart` | 83 | 100% | 1615 |
| `numberOfGroups` | 83 | 100% | 236 |
| `numberOfRules` | 83 | 100% | 236 |

## Unhandled shapes (S5 to-do list)

Shapes seen in fixtures that fall through to the `default` branch or `BLOCK_TYPE.OTHER`:

_All shapes in current fixtures are handled. Run against full what-if dump for a complete picture._
