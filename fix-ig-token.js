const db = require("./db");
const https = require("https");

(async () => {
    await db.initDB();
    const tokens = await db.getAllPlatformTokens(4);
    const ig = tokens.instagram;
    if (ig === undefined || ig === null) {
        console.log("No Instagram token found");
        process.exit(1);
    }
    console.log("has_access_token:", !!ig.access_token);
    console.log("metadata:", JSON.stringify(ig.metadata));

    const url = "https://graph.instagram.com/v21.0/me?fields=user_id,username&access_token=" + ig.access_token;
    https.get(url, (res) => {
        let body = "";
        res.on("data", c => body += c);
        res.on("end", async () => {
            console.log("Instagram /me response:", body);
            try {
                const data = JSON.parse(body);
                const igUserId = data.user_id || data.id;
                if (igUserId) {
                    await db.savePlatformToken(4, "instagram", ig.access_token, ig.refresh_token, ig.expires_at, { user_id: String(igUserId) });
                    console.log("SUCCESS: Updated metadata with user_id:", igUserId);
                } else {
                    console.log("ERROR: No user_id in response");
                }
            } catch (e) {
                console.log("ERROR:", e.message);
            }
            process.exit(0);
        });
    });
})();
