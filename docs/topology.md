# Topology (`topology.json`)

[README](../README.md) · **Topology** · [Configuration](configuration.md) · [Web page](dashboard.md) · [Rack panel](rack.md) · [HTTP API](api.md) · [Development](development.md)

`topology.json` maps dashboard cards to machines and cables to network interfaces. The server reads it at start; restart after editing. It uses the first of these that exists:

1. the file named by `SPARK_SCOPE_TOPOLOGY` (an error if it is missing),
2. `$XDG_CONFIG_HOME/spark-scope/topology.json` (normally `~/.config/spark-scope/topology.json`),
3. the shipped `topology.json` next to `server.mjs` (one locally collected node),
4. a built-in single local node named after the machine.

## Examples

| Example | Layout |
|---|---|
| `examples/topology.1-node.json` | One node, collected locally. Same as the shipped `topology.json`. |
| `examples/topology.2-node.json` | Two nodes joined by two cables (port 0 to port 0, port 1 to port 1). The dashboard runs on `spark-1`; `spark-2` is polled over SSH. Delete the second link if you use one cable. |
| `examples/topology.3-node.json` | Three-node ring polled over SSH. Each node's port 0 goes to the next node's port 1. |
| `examples/topology.4-node.json` | Four-node ring polled over SSH, same cabling pattern. |

## Node fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Short unique id (letters, digits, `_`, `-`; up to 16). Shown in the interconnect diagram. |
| `name` | no | Display name on the card (defaults to `id`). |
| `host` | yes, unless `collect` is false | `"local"` to run the collector on this machine without SSH, or an SSH destination: a `~/.ssh/config` alias (recommended), a hostname, an address or `user@host`. |
| `local` | no | `true` is the same as `"host": "local"`. At most one node can be local. |
| `role` | no | `HEAD`, `WORKER` or anything else; shown under the name. |
| `hardware` | no | Free text shown under the name, for example `DGX Spark`, `ASUS Ascent GX10` or `MSI EdgeXpert`. |
| `collect` | no | `false` shows a card without contacting the node (for a machine that is not set up yet). Its links can still be judged from the other end. |
| `inference` | no | `false` lets this node run without an inference process while the API serves, without degrading the status. |
| `expectedRank` | no | If set, the TP rank parsed from the node's GPU process name must match it. |

## Link fields

| Field | Required | Meaning |
|---|---|---|
| `ends` | yes | Exactly two objects `{ "node": "<id>", "a": "<netdev>", "b": "<netdev>" }`. `a` and `b` are the interfaces of the two logical planes on that end; either may be omitted. |
| `id` | no | Unique id. Defaults to `<node>-<node>`, numbered when several cables join the same pair. |
| `label` | no | Display label. Defaults to `<node>–<node>`, plus `#1`, `#2` for parallel cables. |
| `cabled` | no | `false` for a cable that is not installed yet: dark ports read "not cabled yet" instead of "down" and do not degrade the status. |

## Interfaces and link states

On a DGX Spark-class machine each QSFP port of the ConnectX-7 appears as two network interfaces on different PCIe domains. Port 0 is `enp1s0f0np0` (plane A) and `enP2p1s0f0np0` (plane B); port 1 is `enp1s0f1np1` and `enP2p1s0f1np1`. Check yours with `ip -br link` or `ibdev2netdev`, and find which port a cable uses with `cat /sys/class/net/<interface>/carrier` while plugging it in. Traffic is read from the matching RoCE counters (`rocep1s0f0` and so on) when RDMA devices exist, otherwise from the interface statistics. Links run at 200 Gb/s per plane on these machines; a lower negotiated speed is flagged as slow (see `SPARK_SCOPE_LINK_MIN_GBPS`).

A plane is up when every end that could be observed has carrier. One observed end is enough, because a direct-attach cable only has carrier while its peer is up. A link that no collected node can see is `unknown`, not down, and so is a link with a plane neither end can see while nothing is dark: that usually means a mistyped interface name, so check the names if a link stays `unknown`.

Each interface can appear only once in the whole topology; naming it for two planes or two links is rejected at startup. Topology values (interface names, host aliases) are validated before they reach SSH or the node script.
