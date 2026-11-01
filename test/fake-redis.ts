/**
 * The slice of ioredis the cache uses, in memory. `fail = true` makes every command throw, the way
 * ioredis does with the offline queue off. `log` records every command for assertions.
 */
type Reply = unknown;

export class FakeRedis {
  fail = false;
  /** writes fail inside pipelines the way Redis OOM / MISCONF behaves: reads keep working */
  failWrites = false;
  readonly log: string[][] = [];
  private readonly strings = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly expiry = new Map<string, number>();

  private check(cmd: string[]) {
    this.log.push(cmd);
    if (this.fail) throw new Error(`redis down (${cmd[0]})`);
  }

  private alive(key: string): boolean {
    const exp = this.expiry.get(key);
    if (exp != null && exp <= Date.now()) {
      this.strings.delete(key);
      this.sets.delete(key);
      this.hashes.delete(key);
      this.expiry.delete(key);
      return false;
    }
    return true;
  }

  ttlOf(key: string): number | null {
    const exp = this.expiry.get(key);
    return exp == null ? null : Math.round((exp - Date.now()) / 1000);
  }

  keys(): string[] {
    return [...new Set([...this.strings.keys(), ...this.sets.keys(), ...this.hashes.keys()])].filter(
      (k) => this.alive(k),
    );
  }

  async ping(): Promise<string> {
    this.check(['ping']);
    return 'PONG';
  }

  async get(key: string): Promise<string | null> {
    this.check(['get', key]);
    return this.alive(key) ? (this.strings.get(key) ?? null) : null;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.check(['mget', ...keys]);
    return keys.map((k) => (this.alive(k) ? (this.strings.get(k) ?? null) : null));
  }

  async set(key: string, value: string, ...args: (string | number)[]): Promise<'OK'> {
    this.check(['set', key, value, ...args.map(String)]);
    if (this.failWrites) throw new Error("OOM command not allowed when used memory > 'maxmemory'");
    this.strings.set(key, value);
    this.expiry.delete(key);
    const mode = String(args[0] ?? '').toUpperCase();
    if (mode === 'EX') this.expiry.set(key, Date.now() + Number(args[1]) * 1000);
    if (mode === 'PX') this.expiry.set(key, Date.now() + Number(args[1]));
    return 'OK';
  }

  async mset(...kv: string[]): Promise<'OK'> {
    this.check(['mset', ...kv]);
    for (let i = 0; i < kv.length; i += 2) this.strings.set(kv[i]!, kv[i + 1]!);
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    this.check(['incr', key]);
    const n = Number(this.alive(key) ? (this.strings.get(key) ?? '0') : '0') + 1;
    this.strings.set(key, String(n));
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.check(['expire', key, String(seconds)]);
    this.expiry.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async expireat(key: string, at: number): Promise<number> {
    this.check(['expireat', key, String(at)]);
    this.expiry.set(key, at * 1000);
    return 1;
  }

  async pexpireat(key: string, at: number): Promise<number> {
    this.check(['pexpireat', key, String(at)]);
    this.expiry.set(key, at);
    return 1;
  }

  async del(...keys: string[]): Promise<number> {
    this.check(['del', ...keys]);
    let n = 0;
    for (const k of keys) {
      if (this.strings.delete(k) || this.sets.delete(k) || this.hashes.delete(k)) n++;
      this.expiry.delete(k);
    }
    return n;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.check(['sadd', key, ...members]);
    const set = this.sets.get(key) ?? new Set<string>();
    members.forEach((m) => set.add(m));
    this.sets.set(key, set);
    return members.length;
  }

  async smembers(key: string): Promise<string[]> {
    this.check(['smembers', key]);
    return this.alive(key) ? [...(this.sets.get(key) ?? [])] : [];
  }

  async scard(key: string): Promise<number> {
    this.check(['scard', key]);
    return this.sets.get(key)?.size ?? 0;
  }

  async hincrby(key: string, field: string, by: number): Promise<number> {
    this.check(['hincrby', key, field, String(by)]);
    const h = this.hashes.get(key) ?? new Map<string, string>();
    const n = Number(h.get(field) ?? '0') + by;
    h.set(field, String(n));
    this.hashes.set(key, h);
    return n;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.check(['hgetall', key]);
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async scan(cursor: string, _m: string, pattern: string, _c: string, _n: number): Promise<[string, string[]]> {
    this.check(['scan', cursor, pattern]);
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return ['0', this.keys().filter((k) => re.test(k))];
  }

  async call(cmd: string, ...args: string[]): Promise<Reply> {
    this.check([cmd.toLowerCase(), ...args]);
    if (cmd.toUpperCase() === 'MEMORY' && args[0] === 'USAGE') {
      const v = this.strings.get(args[1]!);
      return v == null ? null : v.length + 50;
    }
    throw new Error(`unsupported ${cmd}`);
  }

  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }
}

type Queued = () => Promise<Reply>;

class FakePipeline {
  private readonly queue: Queued[] = [];
  constructor(private readonly redis: FakeRedis) {}

  private add(fn: Queued): this {
    this.queue.push(fn);
    return this;
  }

  get(key: string) {
    return this.add(() => this.redis.get(key));
  }
  mget(...keys: string[]) {
    return this.add(() => this.redis.mget(...keys));
  }
  set(key: string, value: string, ...args: (string | number)[]) {
    return this.add(() => this.redis.set(key, value, ...args));
  }
  incr(key: string) {
    return this.add(() => this.redis.incr(key));
  }
  expire(key: string, seconds: number) {
    return this.add(() => this.redis.expire(key, seconds));
  }
  expireat(key: string, at: number) {
    return this.add(() => this.redis.expireat(key, at));
  }
  pexpireat(key: string, at: number) {
    return this.add(() => this.redis.pexpireat(key, at));
  }
  del(...keys: string[]) {
    return this.add(() => this.redis.del(...keys));
  }
  sadd(key: string, ...members: string[]) {
    return this.add(() => this.redis.sadd(key, ...members));
  }
  scard(key: string) {
    return this.add(() => this.redis.scard(key));
  }
  hincrby(key: string, field: string, by: number) {
    return this.add(() => this.redis.hincrby(key, field, by));
  }
  hgetall(key: string) {
    return this.add(() => this.redis.hgetall(key));
  }

  /** ioredis shape: `[error, result][]`; a failing connection rejects the whole exec. */
  async exec(): Promise<[Error | null, Reply][]> {
    if (this.redis.fail) {
      this.redis.log.push(['exec']);
      throw new Error('redis down (exec)');
    }
    const out: [Error | null, Reply][] = [];
    for (const fn of this.queue) {
      try {
        out.push([null, await fn()]);
      } catch (err) {
        out.push([err as Error, null]);
      }
    }
    return out;
  }
}
