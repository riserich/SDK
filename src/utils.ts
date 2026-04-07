// @ts-ignore
import { RustDecimal } from "@nvana-dharma/rust-decimal";

/**
 * Serialize a number to Anchor's DecimalSerialized format ({ val: number[] })
 * Used for floor raise parameters in buy instruction
 */
export function serializeDecimal(value: number): { val: number[] } {
  const rustDecimal = RustDecimal.fromFloat(value);
  return { val: Array.from(rustDecimal.serializeToAnchorized()) };
}
