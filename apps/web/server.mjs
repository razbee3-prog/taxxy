// M0 stub: a single page that posts one chat turn to the agent and shows the SSE reply.
import { createServer } from "node:http";

const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:8787";
const PORT = Number(process.env.WEB_PORT ?? 3000);

const page = `<!doctype html><title>Taxxy (M0 stub)</title>
<h1>Taxxy</h1><p>M0 scaffold. Account, bank link and chat arrive with later milestones.</p>
<form id="f"><input id="m" size="60" value="Hello Taxxy"><button>Send</button></form><pre id="out"></pre>
<script>
f.onsubmit=async e=>{e.preventDefault();out.textContent="";
const r=await fetch("/api/turn",{method:"POST",body:JSON.stringify({message:m.value})});
out.textContent=await r.text();};
</script>`;

createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/turn") {
    let body = "";
    for await (const c of req) body += c;
    const { message } = JSON.parse(body || "{}");
    const r = await fetch(`${AGENT_URL}/threads/web-stub/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "web-stub", message }),
    });
    const text = await r.text();
    const final = [...text.matchAll(/^data: (.*)$/gm)]
      .map((m) => JSON.parse(m[1]))
      .find((e) => e.type === "message" || e.type === "error");
    res.end(final?.content ?? final?.error ?? "(no reply)");
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(page);
}).listen(PORT, () => console.log(`taxxy web stub on :${PORT}`));
