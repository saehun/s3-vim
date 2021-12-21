import {
  GetObjectCommand,
  GetObjectCommandOutput,
  ObjectCannedACL as ACL,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import * as JSON5 from 'json5';
import * as prompts from 'prompts';
import * as tmp from 'tmp';
import * as fs from 'fs';
import * as execa from 'execa';
import * as Diff from 'diff';
import { Readable } from 'stream';

type ObjectPath = {
  Bucket: string;
  Key: string;
  Ext: string;
};

type ParseObjectPath = (path: string) => ObjectPath;

type IsUtf8 = (data: GetObjectCommandOutput) => boolean;

type SelectACL = () => Promise<ACL>;

type ShowDiff = (prev: string, next: string) => void;

type PromptConfirm = (message: string) => Promise<boolean>;

type InputPrompt = (text: string) => Promise<string>;

type EnsureJsonString = (text: string) => string;

type FetchObject = (deps: { client: S3Client; isUtf8: IsUtf8 }) => (objectPath: ObjectPath) => Promise<string | null>;

type UpdateObject = (deps: {
  prompt: InputPrompt;
  ensureJsonString: EnsureJsonString;
}) => (objectPath: ObjectPath, prevText: string | null) => Promise<string>;

type Confirm = (deps: {
  showDiff: ShowDiff;
  promptConfirm: PromptConfirm;
}) => (objectPath: ObjectPath, data: { prevText: string | null; nextText: string }, acl: ACL) => Promise<void>;

type PushObject = (deps: { client: S3Client }) => (objectPath: ObjectPath, data: string, acl: ACL) => Promise<void>;

class CustomError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Fetch s3 object
 */
const fetchObject: FetchObject = ({ client, isUtf8 }) => async ({ Bucket, Key }) => {
  try {
    const s3Object = await client.send(
      new GetObjectCommand({
        Bucket,
        Key,
      })
    );
    if (!isUtf8(s3Object) || s3Object.Body == null) {
      throw new CustomError(`Cannot handle non-utf8 object.`);
    }
    return await streamToString(s3Object.Body as Readable);
  } catch (e) {
    if (e.name === 'NoSuchKey') {
      return null;
    }
    if (e.name === 'NoSuchBucket') {
      throw new CustomError(`Bucket not found: '${Bucket}'`);
    }
    throw e;
  }

  async function streamToString(stream: Readable): Promise<string> {
    return await new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
  }
};

/**
 * Update target object using terminal prompts
 */
const updateObject: UpdateObject = ({ prompt, ensureJsonString }) => async (objectPath, text) => {
  let updatedText = await prompt(text || '');
  if (objectPath.Ext === 'json') {
    updatedText = ensureJsonString(updatedText);
  }
  return updatedText;
};

/**
 * Parse given commandline argument into bucket object path, or throw
 */
const parseObjectPath: ParseObjectPath = path => {
  if (typeof path !== 'string') {
    throw new CustomError(`First argument is required. e.g. 'my-bucket/target-file-path.json'`);
  }
  const [bucket, ...rest] = path
    .replace(/^s3:\/\//, '')
    .replace(/^\//, '')
    .split('/');
  const key = rest.join('/');
  const ext = key.split('.').reverse()[0] ?? '';
  if (key.length === 0) {
    throw new CustomError(`Invalid URI argument format. e.g. 'my-bucket/target-file-path.json'`);
  }
  return {
    Bucket: bucket,
    Key: key,
    Ext: ext,
  };
};

const isUtf8: IsUtf8 = data => {
  return data.ContentEncoding === 'utf-8';
};

/**
 * Ask confirm
 */
const confirm: Confirm = ({ promptConfirm, showDiff }) => async (objectPath, { nextText, prevText }, acl) => {
  if (prevText != null) {
    showDiff(prevText, nextText);
  }
  const yes = await promptConfirm(`Push data to ${objectPath.Bucket}/${objectPath.Key} with acl '${acl}'`);
  if (!yes) {
    process.exit(0);
  }
};

/**
 * Upload text to s3
 */
const pushObject: PushObject = ({ client }) => async (objectPath, data, acl) => {
  await client.send(
    new PutObjectCommand({
      Bucket: objectPath.Bucket,
      Key: objectPath.Key,
      ContentType: objectPath.Ext === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      ContentEncoding: 'utf-8',
      ACL: acl,
      Body: data,
    })
  );
};

/**
 * Select ACL private vs public
 */
const selectACL: SelectACL = async () => {
  const { acl } = await prompts(
    {
      name: 'acl',
      type: 'select',
      message: 'Select ACL',
      choices: [
        { title: 'private', value: 'private', selected: true },
        { title: 'public-read', value: 'public-read' },
      ],
    },
    { onCancel: () => process.exit(0) }
  );
  return acl;
};

/**
 * Print text diff on terminal
 */
const showDiff: ShowDiff = (prev, next) => {
  const changes = Diff.diffLines(prev, next);

  changes.forEach(change => {
    const color = (text: string) => {
      return change.added ? `\x1b[32m${text}\x1b[0m` : change.removed ? `\x1b[31m${text}\x1b[0m` : text;
    };
    console.log(color(change.value));
  });
};

/**
 * Ensure that given text is JSON competable, otherwise throw
 */
const ensureJsonString: EnsureJsonString = text => {
  try {
    return JSON.stringify(JSON5.parse(text), null, 2);
  } catch {
    throw new CustomError(`with ext '.json' should be JSON format`);
  }
};

/**
 * Get text input via vim prompts
 */
const vimPrompt: InputPrompt = async text => {
  const { name, removeCallback } = tmp.fileSync({ postfix: '.tmp' });
  try {
    fs.writeFileSync(name, text, { encoding: 'utf-8' });
    await execa('vi', [name], { stdio: 'inherit' });
    return fs.readFileSync(name, 'utf-8');
  } finally {
    removeCallback();
  }
};

/**
 *
 */
const promptConfirm: PromptConfirm = async message => {
  const { yes } = await prompts(
    {
      type: 'confirm',
      name: 'yes',
      message,
    },
    { onCancel: () => process.exit(0) }
  );
  return yes;
};

/**
 * Compose function with its dependencies
 */
function bootStrap(client: S3Client) {
  return {
    fetch: fetchObject({ client, isUtf8 }),
    update: updateObject({
      prompt: vimPrompt,
      ensureJsonString,
    }),
    confirm: confirm({ promptConfirm, showDiff }),
    push: pushObject({ client }),
  } as const;
}

/**
 * Main execution begins here.
 */
async function main(path: string) {
  try {
    const objectPath = parseObjectPath(path);
    const { confirm, fetch, push, update } = bootStrap(new S3Client({}));

    const prevText = await fetch(objectPath);
    const nextText = await update(objectPath, prevText);

    if (prevText === nextText) {
      console.log(`No changes.`);
      process.exit(0);
    }

    const acl = await selectACL();
    await confirm(objectPath, { nextText, prevText }, acl);
    await push(objectPath, nextText, acl);
  } catch (e) {
    if (e instanceof CustomError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

main(process.argv[2]);
