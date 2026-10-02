---
name: Bug report
about: Something on the dashboard or the rack panel is wrong
labels: bug
---

**What happened**

**What you expected**

**Setup**
- Nodes: how many, which hardware (DGX Spark, ASUS GX10, MSI EdgeXpert, other)
- Inference engine and version (vLLM, SGLang), and the parallel layout (TP, DP)
- Where the dashboard runs (a Spark, a Raspberry Pi, another machine) and its Node.js version (`node --version`)
- Browser and device, or the rack display and its size

**Steps to reproduce**

**Screenshot or `/api/state` excerpt**

Remove host names, addresses and anything else you would rather not post. The server log (`journalctl --user -u spark-scope` for the user service) often says why a node or the API could not be read.
