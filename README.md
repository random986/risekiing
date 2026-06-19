# Derivprinterstrategies

Derivprinter is an automated trading interface designed for Deriv synthetic indices using the Options API (WebSocket).

## Strategies Overview

The bot includes several specialized strategies optimized for volatility markets, particularly focusing on digit options like Over/Under and Even/Odd.

### 1. OVER / UNDER Strategies
These strategies trade standard Over/Under digits on Volatility markets.
- **OVER_0_V1**: Trades OVER 0. It expects almost guaranteed wins unless a 0 hits.
- **OVER_3_V1 & OVER_3_V2**: Trades OVER 3.
- **OVER_5_V1**: Trades OVER 5.
- **OVER_6_V2**: Trades OVER 6.
- **UNDER_3_V1**: Trades UNDER 3.
- **UNDER_4_V1**: Trades UNDER 4.
- **UNDER_7_V1**: Trades UNDER 7.
- **UNDER_8_V1**: Trades UNDER 8.
- **UNDER_9_V1**: Trades UNDER 9.

### 2. EVEN / ODD Strategies
- **EVEN_V1**: Trades digits ending in Even numbers (0, 2, 4, 6, 8).
- **ODD_V1**: Trades digits ending in Odd numbers (1, 3, 5, 7, 9).

### 3. Dual-Leg Strategies
- **OU_WINNING**: Opens two opposing positions simultaneously (e.g., OVER 5 and UNDER 4) acting as a hedge. The bot dynamically monitors the outcome of both sides.

## Martingale & Recovery Systems

A core feature of the trade engine is its advanced recovery mechanism for managing losses. 

### Flow-Based Recovery Direction
When a trade results in a loss, the engine switches to a `RECOVERY` phase. Instead of blindly doubling the stake on the same position, it analyzes recent tick trends to pick the best direction:
1. **Flow Analysis**: It evaluates the most recent sequence of ticks.
2. **Frequency Matching**: It counts the frequency of digits matching potential recovery directions (e.g., green vs. red ticks, Over vs. Under).
3. **Direction Selection**: The engine selects the direction that has the most favorable bars (e.g., if there are more "green bars" for OVER 5, it recovers on OVER 5).

### Debt Recovery & Locked Recoveries
- **Debt Tracking**: Every loss is accumulated into a "debt".
- **Locked Recovery**: Once a recovery direction is chosen (e.g., UNDER 4 was determined to be the most favorable), the engine **locks** onto that direction until the entire debt is fully recovered. It does not flip-flop between recovery directions (e.g., switching to OVER 5 halfway).
- **Aggressive Firing**: During the recovery phase, the engine bypasses arbitrary tick-gating and stream-lag delays, executing rapid-fire martingale trades on the very next tick to aggressively clear the debt.

## Technical Execution
The engine uses an optimized event loop that:
- Runs every 50ms, ensuring lightning-fast polling of WebSockets.
- Uses strict lock management (`channel.active`) to guarantee P&L settles before the next trade fires.
- Retains a 10s Websocket ping heartbeat to prevent Deriv API from dropping connections during intense trading periods.