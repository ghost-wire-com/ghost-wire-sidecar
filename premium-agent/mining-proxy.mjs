// Account identity/mode are verified by the console and gateway before this
// handler. The browser never receives the node's control or payout credential.
export function createMiningProxy(config, json) {
	const origin = new URL(config.miningOrigin || config.engineUrl);
	if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
		(origin.protocol !== "https:" && !(origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)))) {
		throw Error("Mining node requires a secure server-owned origin");
	}
	return async (req, res) => {
		if (!req.url.startsWith("/engine/mining")) return false;
		if (
			!config.hostedWorkspace ||
			req.headers["x-ghostwire-mode"] !== (config.workspaceMode || "premium")
		) {
			json(res, 403, { error: "Workspace access is unavailable" });
			return true;
		}
		if (!config.miningSecret) {
			json(res, 503, { error: "Mining is not configured for this node yet" });
			return true;
		}
		const path = req.url.slice("/engine".length);
		if (
			!/^\/mining(?:\/(?:discover|targets|scans)|\/targets\/[0-9a-f-]{36}\/(?:email|dns))?$/.test(
				path,
			) ||
			!["GET", "POST"].includes(req.method)
		) {
			json(res, 404, { error: "Not found" });
			return true;
		}
		const chunks = [];
		let bytes = 0;
		for await (const chunk of req) {
			bytes += chunk.length;
			if (bytes > 8192) {
				json(res, 413, { error: "Request too large" });
				return true;
			}
			chunks.push(chunk);
		}
		try {
			const response = await fetch(new URL(path, origin), {
				method: req.method,
				redirect: "error",
				headers: {
					authorization: `Bearer ${config.miningSecret}`,
					"content-type": "application/json",
					"x-request-id": String(req.headers["x-request-id"] || ""),
				},
				body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
				signal: AbortSignal.timeout(30000),
			});
			const output = [];
			let size = 0;
			for await (const chunk of response.body) {
				size += chunk.length;
				if (size > 6 * 1024 * 1024) throw Error("large");
				output.push(chunk);
			}
			res.writeHead(response.status, {
				"content-type": "application/json",
				"cache-control": "no-store",
			});
			res.end(Buffer.concat(output));
		} catch {
			json(res, 503, {
				error:
					"Mining node is unavailable. Refresh before retrying a submitted assessment",
			});
		}
		return true;
	};
}
