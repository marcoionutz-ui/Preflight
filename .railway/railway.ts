import { defineRailway, github, preserve, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Preflight = github("marcoionutz-ui/Preflight");

  const PreflightRedis = redis("Preflight - Redis", { region: "europe-west4-drams3a" });
  PreflightRedis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  PreflightRedis.networking = { privateNetworkEndpoint: "redis", tcpProxies: { "6379": {} } };
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 5000 });
  PreflightRedis.volumeMounts = { "/data": redisVolume };
  const WorkerSolana = service("Worker Solana", {
    source: Preflight,
    build: "npm ci",
    start: "npm run start --workspace=@preflight/indexer-solana",
    replicas: { "europe-west4-drams3a": 1 },
    networking: { privateNetworkEndpoint: "preflight-production-41cc" },
    env: { MCP_API_KEY: preserve(), MCP_EXPOSE_PERFORMANCE: preserve(), NEXT_PUBLIC_SUPABASE_ANON_KEY: preserve(), NEXT_PUBLIC_SUPABASE_URL: preserve(), REDIS_URL: preserve(), SOLANA_BACKFILL_ENABLED: preserve(), SOLANA_BACKFILL_MAX_ACCOUNTS: preserve(), SOLANA_RPC_URL: preserve(), SOLANA_WS_URL: preserve(), SUPABASE_SERVICE_ROLE_KEY: preserve() },
  });
  const PreflightMCP = service("Preflight MCP", {
    source: github("marcoionutz-ui/Preflight"),
    build: "npm ci && npm run build --workspace=mcp",
    start: "npm run start --workspace=mcp",
    healthcheck: "/api/health",
    replicas: { "europe-west4-drams3a": 1 },
    domains: ["preflight.jackspools.lol"],
    networking: { privateNetworkEndpoint: "preflight" },
    env: { ALCHEMY_ARB_RPC: preserve(), ALCHEMY_ARB_WS: preserve(), ALCHEMY_BASE_RPC: preserve(), ALCHEMY_BASE_WS: preserve(), ALCHEMY_BNB_RPC: preserve(), ALCHEMY_BNB_WS: preserve(), ALCHEMY_ETH_RPC: preserve(), ALCHEMY_ETH_WS: preserve(), ENABLED_CHAINS: preserve(), INDEXER_BNB_USD: preserve(), INDEXER_DRY_RUN: preserve(), INDEXER_ENABLE_ARBITRUM: preserve(), INDEXER_ENABLE_BSC: preserve(), INDEXER_ENABLE_ETHEREUM: preserve(), INDEXER_ENABLE_V4: preserve(), INDEXER_ETH_USD: preserve(), INDEXER_VIRTUAL_USD: preserve(), INDEXER_WETH_USD: preserve(), INDEXER_ZORA_USD: preserve(), MCP_API_KEY: preserve(), MCP_EXPOSE_PERFORMANCE: preserve(), NEXT_PUBLIC_SUPABASE_ANON_KEY: preserve(), NEXT_PUBLIC_SUPABASE_URL: preserve(), REDIS_URL: preserve(), SUPABASE_SERVICE_ROLE_KEY: preserve() },
  });
  const WorkerEVM = service("Worker EVM", {
    source: Preflight,
    build: "npm ci",
    start: "npm run start --workspace=@preflight/worker-evm",
    replicas: { "europe-west4-drams3a": 1 },
    networking: { privateNetworkEndpoint: "worker-evm" },
    env: { ALCHEMY_ARB_RPC: preserve(), ALCHEMY_ARB_WS: preserve(), ALCHEMY_BASE_RPC: preserve(), ALCHEMY_BASE_WS: preserve(), ALCHEMY_BNB_RPC: preserve(), ALCHEMY_BNB_WS: preserve(), ALCHEMY_ETH_RPC: preserve(), ALCHEMY_ETH_WS: preserve(), ENABLED_CHAINS: preserve(), INDEXER_BNB_USD: preserve(), INDEXER_DRY_RUN: preserve(), INDEXER_ENABLE_ARBITRUM: preserve(), INDEXER_ENABLE_BSC: preserve(), INDEXER_ENABLE_ETHEREUM: preserve(), INDEXER_ENABLE_V4: preserve(), INDEXER_ETH_USD: preserve(), INDEXER_VIRTUAL_USD: preserve(), INDEXER_WETH_USD: preserve(), INDEXER_ZORA_USD: preserve(), MCP_API_KEY: preserve(), MCP_EXPOSE_PERFORMANCE: preserve(), NEXT_PUBLIC_SUPABASE_ANON_KEY: preserve(), NEXT_PUBLIC_SUPABASE_URL: preserve(), REDIS_URL: preserve(), SUPABASE_SERVICE_ROLE_KEY: preserve() },
  });
  const IndexerEVM = service("Indexer EVM", {
    source: Preflight,
    build: "npm ci",
    start: "npm run start --workspace=@preflight/indexer-evm",
    replicas: { "europe-west4-drams3a": 1 },
    networking: { privateNetworkEndpoint: "indexer-evm" },
    env: { ALCHEMY_ARB_RPC: preserve(), ALCHEMY_ARB_WS: preserve(), ALCHEMY_BASE_RPC: preserve(), ALCHEMY_BASE_WS: preserve(), ALCHEMY_BNB_RPC: preserve(), ALCHEMY_BNB_WS: preserve(), ALCHEMY_ETH_RPC: preserve(), ALCHEMY_ETH_WS: preserve(), ENABLED_CHAINS: preserve(), INDEXER_BNB_USD: preserve(), INDEXER_DRY_RUN: preserve(), INDEXER_ENABLE_ARBITRUM: preserve(), INDEXER_ENABLE_BSC: preserve(), INDEXER_ENABLE_ETHEREUM: preserve(), INDEXER_ENABLE_V4: preserve(), INDEXER_ETH_USD: preserve(), INDEXER_VIRTUAL_USD: preserve(), INDEXER_WETH_USD: preserve(), INDEXER_ZORA_USD: preserve(), MCP_API_KEY: preserve(), MCP_EXPOSE_PERFORMANCE: preserve(), NEXT_PUBLIC_SUPABASE_ANON_KEY: preserve(), NEXT_PUBLIC_SUPABASE_URL: preserve(), REDIS_URL: preserve(), SUPABASE_SERVICE_ROLE_KEY: preserve() },
  });

  return project("Preflight", {
    resources: [WorkerSolana, PreflightMCP, PreflightRedis, WorkerEVM, IndexerEVM, redisVolume],
  });
});
