# Changelog

## 0.1.0 (2026-10-02)

The first tagged release. Spark Scope went public on 2026-10-01; this covers everything changed since.

### Added

- CPU load, NVMe and ConnectX NIC temperatures, every ACPI thermal zone and the total GPU power, on the web page and the rack panel ([#3](https://github.com/juliankang4/spark-scope/pull/3)).
- A favicon and home-screen icon ([#5](https://github.com/juliankang4/spark-scope/pull/5)).
- Rack panel: a compact layout for five or more nodes and narrow screens, `?width` down to 800, a centred letterbox. Web page: state-coloured badges, a three-way theme button (system, light, dark), a Logical input column in the daily table, eight node colours ([#8](https://github.com/juliankang4/spark-scope/pull/8)).
- `SPARK_SCOPE_ALLOWED_HOSTS` and a Content-Security-Policy on every response ([#9](https://github.com/juliankang4/spark-scope/pull/9)).
- CI on x64 and arm64, contributing and security notes, issue templates ([#10](https://github.com/juliankang4/spark-scope/pull/10)).

### Changed

- `/api/state` calls the engine metrics `inference` (`vllm` is still sent as an alias and will be removed later). It no longer sends the engine URL, the local model path, interface names or raw SSH error text ([#9](https://github.com/juliankang4/spark-scope/pull/9)).
- Requests that name another site's host are refused ([#9](https://github.com/juliankang4/spark-scope/pull/9)). If you reach the dashboard under a name other than localhost, an IP address or the machine's own hostname, add it to `SPARK_SCOPE_ALLOWED_HOSTS`.
- Latency p95 is interpolated inside the histogram bucket, as Prometheus does ([#9](https://github.com/juliankang4/spark-scope/pull/9)).
- Token counts use three significant digits on both pages (`1.5K`, `9.55M`) ([#8](https://github.com/juliankang4/spark-scope/pull/8)).
- The pages poll without history every 2 seconds and fetch it every 30 seconds; responses are gzip-compressed; the rack band moves with a CSS transition instead of a frame loop ([#6](https://github.com/juliankang4/spark-scope/pull/6)).
- The topology is looked for in `~/.config/spark-scope/topology.json` first ([#4](https://github.com/juliankang4/spark-scope/pull/4)).
- The kiosk starts Chromium with `--class=spark-scope-kiosk` and the labwc rule matches only that window. Change an existing `identifier="chromium*"` rule to `spark-scope-kiosk` ([#10](https://github.com/juliankang4/spark-scope/pull/10)).

### Fixed

- iOS Safari scrolled the page on every poll ([#1](https://github.com/juliankang4/spark-scope/pull/1)).
- A hung `nvidia-smi` or `docker` emptied the node card and left processes behind. An SGLang restart could drop tokens from the ledger. Metrics an engine does not export were stored as 0. vLLM data-parallel engines were read as one. Interval settings such as `2s` were accepted ([#2](https://github.com/juliankang4/spark-scope/pull/2)).
- The kiosk hung for host names starting with "rack" and failed to start over SSH. The README quick start missed steps ([#4](https://github.com/juliankang4/spark-scope/pull/4)).
- Stale-data, drawing-error and ledger-month handling on the web page and the rack panel ([#6](https://github.com/juliankang4/spark-scope/pull/6)).
- SGLang's decode rate read 0 while requests ran and spiked when they finished ([#7](https://github.com/juliankang4/spark-scope/pull/7)).
- Long names, rounding at unit boundaries, contrast below AA and a node id `at` breaking the trend charts ([#8](https://github.com/juliankang4/spark-scope/pull/8)).
- Unread engine responses held connections open. A mistyped interface name read as a broken link ([#9](https://github.com/juliankang4/spark-scope/pull/9)).
