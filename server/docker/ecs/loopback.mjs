import { Server } from "node:net";

// Legacy immutable releases did not expose a bind-host option.
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (Number(args[0]) === Number(process.env.STEAMHARNESS_SERVER_PORT)) {
    if (typeof args[1] === "string") args[1] = "127.0.0.1";
    else args.splice(1, 0, "127.0.0.1");
  }
  return listen.apply(this, args);
};
