const PUBLIC_CONFIG_KEYS = Object.freeze({
  url: "SUPABASE_URL",
  anonKey: "SUPABASE_ANON_KEY",
});

function readPublicConfig(env = process.env) {
  const config = {
    supabaseUrl: String(env[PUBLIC_CONFIG_KEYS.url] || "").replace(/\/$/, ""),
    supabaseAnonKey: String(env[PUBLIC_CONFIG_KEYS.anonKey] || ""),
    creditsEnabled: Boolean(env.LITELLM_BASE_URL),
  };

  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return null;
  }

  return config;
}

function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const config = readPublicConfig();
  if (!config) {
    return res.status(503).json({ error: "Engelbart authentication is not configured" });
  }

  return res.status(200).json(config);
}

module.exports = handler;
module.exports.readPublicConfig = readPublicConfig;
