# Rule-Shape Inventory

Generated 2026-04-25 from **312 audits** (312 fixture files).
Fixture root: `tests/fixtures/audits/`

Parser column: ✅ = handled by current `txstFromAudit.js`; ⚠️ = falls through to default/OTHER.

## Block `requirementType`

| Value | Audits | % audits | Occurrences | Parser |
| --- | --- | --- | --- | --- |
| `OTHER` | 312 | 100% | 1027 | ✅ |
| `DEGREE` | 312 | 100% | 312 | ✅ |
| `MAJOR` | 305 | 98% | 305 | ✅ |
| `CONC` | 35 | 11% | 35 | ✅ |
| `MINOR` | 3 | 1% | 3 | ✅ |

## Rule `ruleType`

| Value | Audits | % audits | Occurrences | Parser |
| --- | --- | --- | --- | --- |
| `Course` | 312 | 100% | 11250 | ✅ |
| `Group` | 312 | 100% | 1104 | ✅ |
| `Subset` | 291 | 93% | 1064 | ✅ |
| `Block` | 312 | 100% | 1035 | ✅ |
| `Complete` | 312 | 100% | 681 | ✅ |
| `Blocktype` | 312 | 100% | 562 | ✅ |
| `Incomplete` | 204 | 65% | 217 | ✅ |
| `Noncourse` | 36 | 12% | 87 | ✅ |

## `qualifierArray[].code`

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `HIGHPRIORITY` | 276 | 88% | 1004 |
| `MINGRADE` | 103 | 33% | 562 |
| `NOTGPA` | 53 | 17% | 432 |
| `LOWPRIORITY` | 241 | 77% | 324 |
| `NONEXCLUSIVE` | 127 | 41% | 220 |
| `EXCLUSIVE` | 106 | 34% | 148 |
| `MAXTERM` | 20 | 6% | 136 |
| `LOWESTPRIORITY` | 87 | 28% | 108 |
| `HIDERULE` | 17 | 5% | 29 |
| `MINPERDISC` | 20 | 6% | 20 |

## `exceptionArray[].type`

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `RR` | 311 | 100% | 622 |
| `AA` | 311 | 100% | 313 |
| `NN` | 311 | 100% | 311 |
| `AH` | 311 | 100% | 311 |
| `FC` | 1 | 0% | 1 |

## Course array patterns

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `concrete` | 312 | 100% | 50140 |
| `attrWildcard` | 312 | 100% | 21004 |
| `subjectWildcard` | 193 | 62% | 1477 |
| `attributePlaceholder` | 22 | 7% | 22 |

## `classCreditOperator` values

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `OR` | 312 | 100% | 11161 |
| `AND` | 89 | 29% | 89 |

## `connector` values

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `,` | 312 | 100% | 9805 |
| `+` | 105 | 34% | 1218 |
| `AND` | 42 | 13% | 126 |
| `OR` | 52 | 17% | 101 |

## Structural flags

Presence counts — how many audits contain at least one instance.

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `hideFromAdvice:course` | 312 | 100% | 45777 |
| `withArray` | 312 | 100% | 21358 |
| `ifElsePart` | 312 | 100% | 4733 |
| `numberOfGroups` | 312 | 100% | 1104 |
| `numberOfRules` | 312 | 100% | 1104 |

## Unhandled shapes (S5 to-do list)

Shapes seen in fixtures that fall through to the `default` branch or `BLOCK_TYPE.OTHER`:

_All shapes in current fixtures are handled. Run against full what-if dump for a complete picture._
