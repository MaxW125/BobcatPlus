# Rule-Shape Inventory

Generated 2026-04-25 from **7 audits** (7 fixture files).
Fixture root: `tests/fixtures/audits/`

Parser column: ✅ = handled by current `txstFromAudit.js`; ⚠️ = falls through to default/OTHER.

## Block `requirementType`

| Value | Audits | % audits | Occurrences | Parser |
| --- | --- | --- | --- | --- |
| `OTHER` | 7 | 100% | 25 | ✅ |
| `DEGREE` | 7 | 100% | 7 | ✅ |
| `MAJOR` | 6 | 86% | 6 | ✅ |
| `MINOR` | 3 | 43% | 3 | ✅ |
| `CONC` | 1 | 14% | 1 | ⚠️ unhandled |

## Rule `ruleType`

| Value | Audits | % audits | Occurrences | Parser |
| --- | --- | --- | --- | --- |
| `Course` | 7 | 100% | 268 | ✅ |
| `Group` | 7 | 100% | 31 | ✅ |
| `Subset` | 6 | 86% | 26 | ✅ |
| `Block` | 7 | 100% | 25 | ✅ |
| `Complete` | 7 | 100% | 21 | ✅ |
| `Blocktype` | 7 | 100% | 14 | ✅ |
| `Incomplete` | 4 | 57% | 4 | ✅ |

## `qualifierArray[].code`

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `HIGHPRIORITY` | 6 | 86% | 25 |
| `MINGRADE` | 2 | 29% | 20 |
| `HIDERULE` | 3 | 43% | 15 |
| `LOWESTPRIORITY` | 4 | 57% | 7 |
| `NONEXCLUSIVE` | 4 | 57% | 7 |
| `NOTGPA` | 1 | 14% | 5 |
| `LOWPRIORITY` | 3 | 43% | 4 |
| `EXCLUSIVE` | 2 | 29% | 3 |

## `exceptionArray[].type`

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `RR` | 6 | 86% | 12 |
| `AA` | 6 | 86% | 8 |
| `NN` | 6 | 86% | 6 |
| `AH` | 6 | 86% | 6 |
| `FC` | 1 | 14% | 1 |

## Course array patterns

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `concrete` | 7 | 100% | 1258 |
| `attrWildcard` | 7 | 100% | 381 |
| `subjectWildcard` | 6 | 86% | 63 |
| `attributePlaceholder` | 3 | 43% | 3 |

## `classCreditOperator` values

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `OR` | 7 | 100% | 266 |
| `AND` | 2 | 29% | 2 |

## `connector` values

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `,` | 7 | 100% | 231 |
| `+` | 2 | 29% | 27 |
| `AND` | 2 | 29% | 7 |
| `OR` | 2 | 29% | 3 |

## Structural flags

Presence counts — how many audits contain at least one instance.

| Value | Audits | % audits | Occurrences |
| --- | --- | --- | --- |
| `hideFromAdvice:course` | 7 | 100% | 856 |
| `withArray` | 7 | 100% | 397 |
| `ifElsePart` | 7 | 100% | 133 |
| `numberOfGroups` | 7 | 100% | 31 |
| `numberOfRules` | 7 | 100% | 31 |

## Unhandled shapes (S5 to-do list)

Shapes seen in fixtures that fall through to the `default` branch or `BLOCK_TYPE.OTHER`:

**requirementType** (falls to `BLOCK_TYPE.OTHER`): `CONC`
