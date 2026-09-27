# Synthetic replay fixtures

These fixtures are authored for this repository and are deliberately small, public and synthetic.
They demonstrate the replay and comparison tools; they are not the prototype corpora, and they are
not evidence about retrieval quality.

## Sources

`synthetic-sources.jsonl` holds ten ordered source entries covering two unrelated domains, a
historical record, a requirement, an audit record, an exception, a recommendation, an attributed
finding followed by the attributed response to it, and one policy subject under two conflicting
regional scopes (`Europe` and `North America`). Each entry carries the
[documented fields](../README.md#fixtures): `sourceId`, `content`, `timestamp` and optional
`metadata`. Expected source IDs are the `requiredSourceIds` of the query cases.

## Queries

`synthetic-queries.jsonl` holds eight query cases whose expected evidence was fixed before
insertion:

| Query ID                    | Required source IDs                                         |
| --------------------------- | ----------------------------------------------------------- |
| `approval-requirement`      | `queue-approval-requirement`                                |
| `approval-history`          | `queue-approval-record`, `queue-approval-audit`             |
| `retention-window`          | `queue-retention-europe`                                    |
| `retention-exception`       | `queue-retention-europe`, `queue-retention-audit-exception` |
| `retention-north-america`   | `queue-retention-north-america`                             |
| `approval-finding-response` | `queue-approval-finding`, `queue-approval-response`         |
| `roof-repair`               | `roof-inspection-storm`, `roof-repair-recommendation`       |
| `stale-retention-ambiguity` | `queue-retention-europe`                                    |

Query text is never inserted as source material. Review these paraphrases before judging output
against them; a fixture with ambiguous wording makes the evaluation weaker, not the memory better.
