---
summary: "Outcome responsibility and acceptance layer."
read_when:
  - You are installing, configuring, or auditing the outcomes plugin
title: "Outcomes plugin"
---

# Outcomes plugin

Outcome responsibility and acceptance layer.

## Distribution

- Package: `@openclaw/outcomes`
- Install route: included in OpenClaw

## Surface

plugin

The persisted Outcome record and its decoder remain plugin-local. The bundled
plugin API has a test-only candidate-archive assertion that accepts opaque
restored input and returns neither a persisted record nor a record type.
