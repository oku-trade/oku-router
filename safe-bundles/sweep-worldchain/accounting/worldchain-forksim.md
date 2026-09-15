# Fee Sweep - FORK SIMULATION (no funds moved)

> This run happened on a local fork. Nothing here touched a live chain; it exists to prove the sweep behaves as expected and that this artifact format is correct before any signature is collected.

| | |
|---|---|
| Network | worldchain (chainId 480) |
| Bundle | `sweep-worldchain` |
| Router | `0xb1f3a7B816B0681188F54dFa400991B93ADf00ed` |
| Safe | `0xdC91978e0617CcA2EE1E658d0A1CA3F63CF10f1F` |
| Recipient | `0xd637f2A36c1a3b37d57ef4C7022cB183D8922f2c` |
| Tx | `0x6eaf8bd61673fb0c1e4ce9833e514791289cc0ad139aa46dbbd9ca96d4c935ec` |
| Block | 35079863 (2026-09-15T18:02:49.000Z) |
| Safe nonce | 1 |
| Gas | 1313264 @ 1000438680 wei = 0.00131384010265152 ($3.20) |
| Status | success |
| Generated | 2026-09-15T18:07:35.195Z |

## Assets swept (33)

| Asset | Amount | USD | Realizable | Verified |
|---|---:|---:|---:|---|
| USDC | 199.047646 | $199.05 | $199.05 | yes |
| WLD | 478.540064859254484906 | $178.86 | $178.86 | yes |
| FOOTBALL | 1274.189828354676818338 | $111.89 | $0.00 | yes |
| WETH | 0.014910710930730565 | $36.37 | $36.37 | yes |
| wARS | 20513.05761344659070732 | $13.46 | $0.00 | yes |
| ORB | 39437.16466048352035186 | $5.83 | $5.83 | yes |
| WDD | 37679.089556828596671332 | $4.72 | $4.72 | yes |
| uDOGE | 44.085082236535075942 | $3.50 | $3.50 | yes |
| SUSHI | 1093758.901505130187426561 | $1.74 | $1.74 | yes |
| uSOL | 0.007194810240237531 | $0.73 | $0.73 | yes |
| ORO | 274.929688118471332375 | $0.71 | $0.71 | yes |
| WBTC | 0.00000352 | $0.27 | $0.27 | yes |
| EURC | 0.162359 | $0.20 | $0.20 | yes |
| wPEN | 0.358335356585785485 | $0.11 | $0.00 | yes |
| uXRP | 0.045828304465542372 | $0.06 | $0.06 | yes |
| DIAMANTE | 2.750222745356683667 | $0.04 | $0.04 | yes |
| wMXN | 0.259439588224941877 | $0.02 | $0.00 | yes |
| wBRL | 0.031399135917496908 | $0.01 | $0.00 | yes |
| wCOP | 17.949463213391511284 | $0.01 | $0.00 | yes |
| FRUIT | 1.161632316822360331 | $0.00 | $0.00 | yes |
| wCLP | 1.288633569736213648 | $0.00 | $0.00 | yes |
| BOWSER | 942.147255969 | $0.00 | $0.00 | yes |
| USD₮0 | 0.00074 | $0.00 | $0.00 | yes |
| POOL | 0.004669135776107602 | $0.00 | $0.00 | yes |
| uSUI | 0.000035255856716703 | $0.00 | $0.00 | yes |
| OPEN | 0.940338645435249251 | $0.00 | $0.00 | yes |
| LOC | 542.239892729167718132 | - | - | yes |
| WFUND | 2256.514052085755666048 | - | - | yes |
| wsrUSD | 0.000070420123558229 | - | - | yes |
| WARMY | 2563.964994755625176455 | - | - | yes |
| rUSD | 0.021688436075228799 | - | - | yes |
| IDRX | 2.15 | - | - | yes |
| ETH | 0.000475715885715518 | $1.16 | $1.16 | yes |

**Notional:** $558.70  
**Realizable:** $433.22

Notional is spot price x amount. Realizable caps each asset at a fraction of its pool depth, because long-tail tokens quote prices against pools with no liquidity. Realizable is the meaningful figure.

## Reconciliation

- Router fully drained: **yes**
- Events match measured balance deltas: **yes**

### Warnings

- fork simulation: gas price and native valuation come from the forked EVM, not the live chain
