/**
 * Minimal clients for the line protocols the platform has no SDK for yet (clamd, RESP, SMTP, SIP).
 * They speak the documented wire formats to the emulators; they are test clients, not adapters.
 */
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { connect } from "node:net";

/** Sends `payload` on a TCP connection and resolves with everything read until the peer closes. */
export function tcpExchange(port: number, payload: Buffer | string, timeoutMs = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP_TIMEOUT: 127.0.0.1:${port}`));
    }, timeoutMs);
    socket.on("connect", () => socket.end(payload));
    socket.on("data", (d) => chunks.push(d));
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

/** clamd INSTREAM: chunked stream (4-byte big-endian length prefix), zero-length terminator. */
export function clamdInstream(port: number, body: Buffer): Promise<string> {
  const header = Buffer.from("zINSTREAM\0");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const end = Buffer.alloc(4);
  return tcpExchange(port, Buffer.concat([header, len, body, end]));
}

/**
 * The standard EICAR anti-virus test file, assembled at runtime so the repository never contains
 * the signature string itself (it is not malware; every scanner reports it by design).
 */
export function eicarTestFile(): Buffer {
  const parts = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}", "$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!", "$H+H*"];
  return Buffer.from(parts.join(""), "ascii");
}

/** RESP command encoding. */
export function resp(...args: string[]): string {
  return `*${args.length}\r\n${args.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`;
}

/** Talks SMTP step by step (waits for each reply code) and returns the transcript of server replies. */
export function smtpSend(port: number, from: string, to: string, data: string, timeoutMs = 10_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const replies: string[] = [];
    const steps = [`EHLO vsp-layer2.local`, `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, "DATA", `${data.replace(/\r?\n/g, "\r\n")}\r\n.`, "QUIT"];
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP_TIMEOUT"));
    }, timeoutMs);
    socket.on("data", (d) => {
      buffer += d.toString("utf8");
      // A complete reply ends with a line "NNN text" (no hyphen after the code).
      while (/(^|\r\n)\d{3} [^\r\n]*\r\n/.test(buffer)) {
        const m = /(^|\r\n)(\d{3}) [^\r\n]*\r\n/.exec(buffer);
        if (!m) break;
        const endIdx = (m.index ?? 0) + m[0].length;
        replies.push(buffer.slice(0, endIdx).trim());
        buffer = buffer.slice(endIdx);
        const next = steps.shift();
        if (next === undefined) {
          socket.end();
          break;
        }
        socket.write(`${next}\r\n`);
      }
    });
    socket.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(replies);
    });
  });
}

/** Sends a SIP OPTIONS request over UDP and resolves with the first response (RFC 3261 section 11). */
export function sipOptions(port: number, timeoutMs = 5_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = createSocket("udp4");
    const branch = `z9hG4bK${randomBytes(8).toString("hex")}`;
    const tag = randomBytes(6).toString("hex");
    const callId = `${randomBytes(10).toString("hex")}@vsp-layer2.local`;
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error("SIP_TIMEOUT"));
    }, timeoutMs);
    sock.on("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg.toString("utf8"));
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      sock.close();
      reject(e);
    });
    sock.bind(0, "127.0.0.1", () => {
      const local = sock.address().port;
      const req = [
        `OPTIONS sip:probe@127.0.0.1:${port} SIP/2.0`,
        `Via: SIP/2.0/UDP 127.0.0.1:${local};branch=${branch};rport`,
        "Max-Forwards: 70",
        `From: <sip:layer2@vsp-layer2.local>;tag=${tag}`,
        `To: <sip:probe@127.0.0.1:${port}>`,
        `Call-ID: ${callId}`,
        "CSeq: 1 OPTIONS",
        `Contact: <sip:layer2@127.0.0.1:${local}>`,
        "Accept: application/sdp",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n");
      sock.send(req, port, "127.0.0.1");
    });
  });
}

/** A minimal SIP user agent over UDP (one dialog): enough to place, answer-wait and hang up a call. */
export class SipUdpClient {
  private readonly messages: string[] = [];
  private readonly waiters: { match: (m: string) => boolean; resolve: (m: string) => void }[] = [];
  readonly callId = `${randomBytes(10).toString("hex")}@vsp-layer2.local`;
  readonly fromTag = randomBytes(6).toString("hex");
  private cseq = 1;

  private constructor(
    private readonly sock: ReturnType<typeof createSocket>,
    readonly localPort: number,
    private readonly serverPort: number,
  ) {
    sock.on("message", (msg) => {
      const text = msg.toString("utf8");
      this.messages.push(text);
      for (const w of [...this.waiters]) {
        if (w.match(text)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(text);
        }
      }
    });
  }

  static open(serverPort: number): Promise<SipUdpClient> {
    const sock = createSocket("udp4");
    return new Promise((resolve) => sock.bind(0, "127.0.0.1", () => resolve(new SipUdpClient(sock, sock.address().port, serverPort))));
  }

  private headers(method: string, requestUri: string, to: string, cseq: number, extra: string[] = []): string[] {
    return [
      `${method} ${requestUri} SIP/2.0`,
      `Via: SIP/2.0/UDP 127.0.0.1:${this.localPort};branch=z9hG4bK${randomBytes(8).toString("hex")};rport`,
      "Max-Forwards: 70",
      `From: <sip:+15550199@layer2.example.test>;tag=${this.fromTag}`,
      `To: ${to}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} ${method}`,
      `Contact: <sip:+15550199@127.0.0.1:${this.localPort}>`,
      ...extra,
    ];
  }

  /** INVITE with a PCMU/telephone-event SDP offer. */
  invite(number: string): void {
    const sdp = ["v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "c=IN IP4 127.0.0.1", "t=0 0", "m=audio 40000 RTP/AVP 0 101", "a=rtpmap:0 PCMU/8000", "a=rtpmap:101 telephone-event/8000", "a=sendrecv", ""].join("\r\n");
    const msg = [...this.headers("INVITE", `sip:${number}@127.0.0.1:${this.serverPort}`, `<sip:${number}@127.0.0.1>`, this.cseq, ["Content-Type: application/sdp", `Content-Length: ${Buffer.byteLength(sdp)}`]), "", sdp].join("\r\n");
    this.sock.send(msg, this.serverPort, "127.0.0.1");
  }

  /** ACK for a 2xx, then BYE inside the dialog the 200 OK established. */
  ackAndBye(ok: string, number: string): void {
    const to = /^To:\s*(.+)$/im.exec(ok)?.[1]?.trim() ?? `<sip:${number}@127.0.0.1>`;
    const contact = /^Contact:\s*<([^>]+)>/im.exec(ok)?.[1] ?? `sip:${number}@127.0.0.1:${this.serverPort}`;
    this.sock.send([...this.headers("ACK", contact, to, this.cseq, ["Content-Length: 0"]), "", ""].join("\r\n"), this.serverPort, "127.0.0.1");
    this.cseq += 1;
    this.sock.send([...this.headers("BYE", contact, to, this.cseq, ["Content-Length: 0"]), "", ""].join("\r\n"), this.serverPort, "127.0.0.1");
  }

  waitFor(pattern: RegExp, timeoutMs = 10_000): Promise<string> {
    const seen = this.messages.find((m) => pattern.test(m));
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SIP_TIMEOUT waiting for ${pattern.source}; got ${this.messages.map((m) => m.split("\r\n")[0]).join(" | ")}`)), timeoutMs);
      this.waiters.push({
        match: (m) => pattern.test(m),
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  statusLines(): string[] {
    return this.messages.map((m) => m.split("\r\n")[0] ?? "");
  }

  close(): void {
    this.sock.close();
  }
}
