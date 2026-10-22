/**
 * DTMF menu navigation in the runtime (WP-11; FO-10-18): digits pressed by the caller select a navigation action
 * from tenant configuration (a person, repeat, slower or normal speech, decline recording or AI processing). Digits
 * reach only this menu: never ASR, a model, a transcript, a recorder or a log line (AUTH-06); only the selected
 * action name is passed on. While a secure entry (one-time code, WP-12) is collecting digits, the menu is suspended
 * and every digit goes to that collector instead.
 */
import { z } from "zod";

export const MenuAction = z.enum(["REQUEST_HUMAN", "REPEAT", "SLOWER", "NORMAL_SPEED", "DECLINE_RECORDING", "DECLINE_AI_PROCESSING"]);
export type MenuAction = z.infer<typeof MenuAction>;

const Digit = z.enum(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#"]);
export const DtmfMenuConfig = z.partialRecord(Digit, MenuAction).refine((m) => Object.values(m).includes("REQUEST_HUMAN"), "a menu always offers a person");
export type DtmfMenuConfig = z.infer<typeof DtmfMenuConfig>;

/** Engineering default; the tenant's approved menu replaces it (the prompts that announce it are approved wording, WP-14). */
export const DEFAULT_DTMF_MENU: DtmfMenuConfig = { "0": "REQUEST_HUMAN", "1": "REPEAT", "2": "SLOWER", "3": "NORMAL_SPEED", "8": "DECLINE_RECORDING", "9": "DECLINE_AI_PROCESSING" };

export interface SecureDigitCollector {
  /** Receives a digit during secure entry; the menu never sees it. */
  accept(digit: string): void;
}

export class DtmfMenu {
  private readonly map: DtmfMenuConfig;
  private secure: SecureDigitCollector | null = null;

  constructor(config: DtmfMenuConfig = DEFAULT_DTMF_MENU) {
    this.map = DtmfMenuConfig.parse(config);
  }

  /** Suspends navigation while a secure collector takes the digits; returns the release function. */
  beginSecureEntry(collector: SecureDigitCollector): () => void {
    this.secure = collector;
    return () => {
      if (this.secure === collector) this.secure = null;
    };
  }

  /** The action a digit selects, or null (unmapped digit, or secure entry in progress). */
  onDigit(digit: string): MenuAction | null {
    if (this.secure) {
      this.secure.accept(digit);
      return null;
    }
    const d = Digit.safeParse(digit);
    if (!d.success) return null;
    return this.map[d.data] ?? null;
  }
}
