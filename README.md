# Flair (Harper-native)

Flair is a Harper v5 application for agent identity, memory, and soul state.

## Architecture
- Harper is the HTTP server + RocksDB persistence runtime
- `@table @export` auto-CRUD for Agent/Integration
- Memory/Soul are table extensions with custom durability behavior
- Ed25519 request auth via Harper HTTP middleware (`runFirst`)
- Harper JWT token resources for CLI/human flows

## Layout
- `config.yaml`
- `schemas/*.graphql`
- `resources/*.ts`
- `src/cli.ts`

## Security
- API never accepts plaintext credentials for integrations
- Ed25519 format: `TPS-Ed25519 <agentId>:<timestamp>:<nonce>:<signature>`
- 30s replay window + nonce dedup
- Permanent memory rejects DELETE

## Development
```bash
bun install
bun run build
bun test
```
