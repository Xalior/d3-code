// The backend child inherits this (`extendEnv: true`). Node's 4-thread default lets the
// workspace index's directory reads starve every other file call: turn start, review, status.
process.env.UV_THREADPOOL_SIZE ??= "64";
