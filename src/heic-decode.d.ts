declare module "heic-decode" {
  export interface DecodedImage {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  }

  export default function decode(options: {
    buffer: Buffer | Uint8Array;
  }): Promise<DecodedImage>;
}
