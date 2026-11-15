# Phase 12 evaluation

Deterministic replay over fixed synthetic search fixtures and scripted model responses. Timing is local harness timing. Provider spend is $0 for replay.

| Pipeline    | Correct | Grounded | Citation precision | p50 ms | p95 ms | Model calls / question | Credits / question | Tokens / question | Estimated USD / question |
| ----------- | ------: | -------: | -----------------: | -----: | -----: | ---------------------: | -----------------: | ----------------: | -----------------------: |
| baseline    |   57.1% |    57.1% |             100.0% |      0 |      1 |                   1.00 |               1.00 |               135 |                        0 |
| full        |  100.0% |   100.0% |             100.0% |     14 |     39 |                   3.43 |               0.86 |               463 |                        0 |
| no-reranker |  100.0% |   100.0% |             100.0% |      9 |     15 |                   3.43 |               0.86 |               463 |                        0 |
| no-verifier |   97.6% |    97.6% |             100.0% |      9 |     14 |                   3.43 |               0.86 |               463 |                        0 |
| no-cascade  |  100.0% |   100.0% |             100.0% |      8 |     14 |                   3.43 |               0.86 |               463 |                        0 |
| no-cache    |  100.0% |   100.0% |             100.0% |      8 |     16 |                   3.43 |               0.86 |               463 |                        0 |
| no-filters  |  100.0% |   100.0% |             100.0% |      8 |     12 |                   3.43 |               0.86 |               463 |                        0 |

Full pipeline misses: none.

Ablations with no measured quality change, flagged for removal review: no-reranker, no-cascade, no-cache, no-filters.
Synthetic replay uses scripted models and a lightweight reranker. Equal scores here require live follow-up before removing components.
