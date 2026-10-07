/**
 * Minimal promise-based ZIP *reader*, over yauzl.
 *
 * `archiver` (used by the report routes and the engagement export) only writes;
 * reading a container back needs yauzl. The point of using it rather than
 * inflating everything is its central-directory access: opening an archive lists
 * every entry and its declared size without decompressing a byte, so a caller can
 * validate a small metadata entry — and reject an archive outright — before paying
 * for the large ones. {@link ZipReader.read} then inflates exactly one entry.
 *
 * Deliberately not a general-purpose extractor: nothing here writes to disk, so an
 * entry name is only ever a lookup key (no path traversal surface). Callers are
 * expected to accept a known set of names and ignore the rest.
 */
import yauzl from 'yauzl';

/** What the central directory says about one entry, before anything is inflated. */
export interface ZipEntryInfo {
  name: string;
  /** Declared inflated size. Enforced on read, so it can be trusted as a bound. */
  uncompressedSize: number;
  /** Size of the stored (compressed) bytes — the two together give the ratio. */
  compressedSize: number;
}

export interface ZipReader {
  /** Every file entry, keyed by name, in central-directory order. */
  readonly entries: ReadonlyMap<string, ZipEntryInfo>;
  /** Inflate one entry into a buffer. Rejects if the name is not in the archive. */
  read(name: string): Promise<Buffer>;
  /** Release the underlying handle. Safe to call more than once. */
  close(): void;
}

/**
 * Open a ZIP held in memory and index its central directory.
 *
 * Duplicate entry names are rejected. A ZIP file format allows them, and which one
 * a reader sees depends on whether it walks the central directory or the local
 * headers — so a file with two `manifest.json` entries could mean different things
 * to a validator and to whatever consumes the data afterwards. Refusing them keeps
 * "the entry named X" unambiguous.
 *
 * `validateEntrySizes` (yauzl's default, set explicitly here because the guarantee
 * is load-bearing) makes a read fail if the inflated bytes don't match the declared
 * `uncompressedSize`, which is what lets a caller treat the declared sizes as a
 * real budget rather than a hint.
 */
export function openZip(buffer: Buffer): Promise<ZipReader> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true, decodeStrings: true },
      (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('not a ZIP archive'));

        const entries = new Map<string, ZipEntryInfo>();
        const handles = new Map<string, yauzl.Entry>();

        zip.on('entry', (entry: yauzl.Entry) => {
          // Directory entries carry no content; they exist only to hold a name.
          if (entry.fileName.endsWith('/')) return zip.readEntry();
          if (entries.has(entry.fileName)) {
            zip.close();
            return reject(new Error(`duplicate ZIP entry “${entry.fileName}”`));
          }
          entries.set(entry.fileName, {
            name: entry.fileName,
            uncompressedSize: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
          });
          handles.set(entry.fileName, entry);
          zip.readEntry();
        });

        zip.on('error', reject);
        zip.on('end', () => {
          resolve({
            entries,
            read: (name) => readEntry(zip, handles, name),
            close: () => zip.close(),
          });
        });

        zip.readEntry();
      },
    );
  });
}

function readEntry(
  zip: yauzl.ZipFile,
  handles: Map<string, yauzl.Entry>,
  name: string,
): Promise<Buffer> {
  const entry = handles.get(name);
  if (!entry) return Promise.reject(new Error(`no ZIP entry named “${name}”`));
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error(`cannot read ZIP entry “${name}”`));
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}
