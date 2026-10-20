/**
 * LOCAL TEST FIXTURE (unit tests only; refused in Layer 2 by test/integration/_harness/no-unit-fakes.ts):
 * an in-process stand-in for the two KMS operations the manifest signer uses (GetPublicKey, Sign with
 * MessageType RAW), backed by a P-256 key generated per instance. It is NOT KMS: key custody, key
 * policy and grants are not modelled. Layer 2 runs KmsManifestSigner against LocalStack KMS instead.
 */
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import type { KmsSignSender } from "./signer.js";

export class KmsSignStubFixture implements KmsSignSender {
  readonly label = "LOCAL FIXTURE KMS STUB — not KMS";
  readonly keyArn: string;
  readonly publicKey: KeyObject;
  private readonly privateKey: KeyObject;
  signCalls = 0;
  failSign = false;

  constructor(keyArn = "arn:aws:kms:us-east-1:123456789012:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0") {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.keyArn = keyArn;
  }

  async send(command: SignCommand | GetPublicKeyCommand): Promise<unknown> {
    if (command instanceof GetPublicKeyCommand) {
      return {
        KeyId: this.keyArn,
        PublicKey: new Uint8Array(this.publicKey.export({ format: "der", type: "spki" })),
        KeySpec: "ECC_NIST_P256",
        KeyUsage: "SIGN_VERIFY",
        SigningAlgorithms: ["ECDSA_SHA_256"],
      };
    }
    if (this.failSign) throw Object.assign(new Error("stub sign failure"), { name: "KMSInternalException" });
    this.signCalls += 1;
    const input = command.input;
    if (input.MessageType !== "RAW" || !(input.Message instanceof Uint8Array) || input.Message.length > 4096) throw new Error("stub expects a RAW message of at most 4096 bytes");
    const signature = nodeSign("sha256", Buffer.from(input.Message), { key: this.privateKey, dsaEncoding: "der" });
    return { Signature: new Uint8Array(signature), SigningAlgorithm: "ECDSA_SHA_256", KeyId: this.keyArn };
  }
}
