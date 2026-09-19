import type { IncomingMessage } from "node:http";
import type http from "node:http";
import type { Duplex } from "node:stream";
import cookie from "cookie";
import type Koa from "koa";
import { Op } from "sequelize";
import IO from "socket.io";
import { createAdapter } from "socket.io-redis";
import { errToId, errToString, toError } from "@shared/utils/error";
import env from "@server/env";
import { AuthenticationError } from "@server/errors";
import Logger from "@server/logging/Logger";
import Metrics from "@server/logging/Metrics";
import * as Tracing from "@server/logging/tracer";
import { traceFunction } from "@server/logging/tracing";
import { ChannelMembership, User } from "@server/models";
import { rejectUpgrade } from "@server/onupgrade";
import Redis from "@server/storage/redis";
import ShutdownHelper, { ShutdownOrder } from "@server/utils/ShutdownHelper";
import { getUserForJWT } from "@server/utils/jwt";
import { websocketQueue } from "../queues";
import WebsocketsProcessor from "../queues/processors/WebsocketsProcessor";

type SocketWithAuth = IO.Socket & {
  client: IO.Socket["client"] & {
    auth?: { userId: string; teamId: string };
  };
};

export default function init(
  app: Koa,
  server: http.Server,
  serviceNames: string[]
) {
  const path = "/realtime";

  // Websockets for events and non-collaborative documents
  const io = new IO.Server(server, {
    path,
    serveClient: false,
    cookie: false,
    pingInterval: 15000,
    pingTimeout: 30000,
    cors: {
      // Included for completeness, though CORS does not apply to websocket transport.
      origin: env.isCloudHosted ? "*" : env.URL,
      methods: ["GET", "POST"],
    },
  });

  // Remove the upgrade handler that we just added when registering the IO engine
  // And re-add it with a check to only handle the realtime path, this allows
  // collaboration websockets to exist in the same process as engine.io.
  const listeners = server.listeners("upgrade");
  const ioHandleUpgrade = listeners.pop();

  if (ioHandleUpgrade) {
    server.removeListener(
      "upgrade",
      ioHandleUpgrade as (...args: unknown[]) => void
    );
  }

  server.on(
    "upgrade",
    function (req: IncomingMessage, socket: Duplex, head: Buffer) {
      if (req.url?.startsWith(path) && ioHandleUpgrade) {
        // For on-premise deployments, ensure the websocket origin matches the deployed URL.
        // In cloud-hosted we support any origin for custom domains.
        if (
          !env.isCloudHosted &&
          (!req.headers.origin || !env.URL.startsWith(req.headers.origin))
        ) {
          rejectUpgrade(socket);
          return;
        }

        ioHandleUpgrade(req, socket, head);
        return;
      }

      if (serviceNames.includes("collaboration")) {
        // Nothing to do, the collaboration service will handle this request
        return;
      }

      // If the collaboration service isn't running then we need to close the connection
      rejectUpgrade(socket);
    }
  );

  ShutdownHelper.add("websockets", ShutdownOrder.normal, async () => {
    Metrics.gaugePerInstance("websockets.count", 0);
  });

  io.adapter(
    createAdapter({
      pubClient: Redis.defaultClient,
      subClient: Redis.defaultSubscriber,
    })
  );

  io.of("/").adapter.on("error", (err: Error) => {
    if (err.name === "MaxRetriesPerRequestError") {
      Logger.fatal("Redis maximum retries exceeded in socketio adapter", err);
    } else {
      Logger.error("Redis error in socketio adapter", err);
    }
  });

  io.on("connection", async (socket: SocketWithAuth) => {
    Metrics.increment("websockets.connected");
    Metrics.gaugePerInstance("websockets.count", io.engine.clientsCount);

    // If the socket didn't authenticate after connection, disconnect it
    const authTimeout = setTimeout(function () {
      if (!socket.client.auth) {
        Logger.debug("websockets", `Disconnecting socket ${socket.id}`);

        // @ts-expect-error should be boolean
        socket.disconnect("unauthorized");
      }
    }, 1000);

    socket.on("disconnect", async () => {
      Metrics.increment("websockets.disconnected");
      Metrics.gaugePerInstance("websockets.count", io.engine.clientsCount);

      // Cancel the pending auth timeout, now we're disconnected
      clearTimeout(authTimeout);

      // Capture before clearing - this is the last point we know who this
      // socket belonged to.
      const disconnectedAuth = socket.client.auth;

      // Release the connection's auth reference so it isn't retained
      socket.client.auth = undefined;

      if (disconnectedAuth) {
        void reportOfflineIfLastConnection(io, disconnectedAuth).catch(
          (err) => {
            Logger.error("Failed to report user offline", toError(err), {
              userId: disconnectedAuth.userId,
            });
          }
        );
      }
    });

    try {
      const user = await authenticate(socket);
      Logger.debug("websockets", `Authenticated socket ${socket.id}`);

      socket.emit("authenticated", true);
      void authenticated(io, socket, user).catch((err) => {
        Logger.error(
          "Failed to join rooms for authenticated socket",
          toError(err),
          {
            socketId: socket.id,
            userId: user.id,
          }
        );

        // The socket receives no events without its rooms, disconnect so that
        // the client reconnects and tries again.
        socket.disconnect();
      });

      // Redundant "online" emits from a second tab/device are harmless (the
      // client-side state is idempotent) - so this doesn't need to check
      // whether this is the user's first connected socket, unlike the
      // "offline" case below which does.
      io.to(`team-${user.teamId}`).emit("presence.online", {
        userId: user.id,
      });

      // presence.online/offline above are deltas - a socket that connects
      // after other users are already online never receives an event for
      // them, and unlike every other realtime feature here there's no DB
      // row to reconcile via a REST fetch on mount (presence is live socket
      // state, not persisted). So the newly-connecting client needs an
      // explicit snapshot of who's online right now, sent once, directly to
      // it alone.
      void sendPresenceSnapshot(io, socket, user).catch((err) => {
        Logger.error("Failed to send presence snapshot", toError(err), {
          socketId: socket.id,
          userId: user.id,
        });
      });
    } catch (err) {
      const message = errToString(err);
      Logger.debug("websockets", `Authentication error socket ${socket.id}`, {
        error: message,
      });
      socket.emit("unauthorized", { message, id: errToId(err) }, function () {
        socket.disconnect();
      });
    }
  });

  // Handle events from event queue that should be sent to the clients down ws
  const websockets = new WebsocketsProcessor();
  websocketQueue()
    .process(
      traceFunction({
        serviceName: "websockets",
        spanName: "process",
        isRoot: true,
      })(async function (job) {
        const event = job.data;

        Tracing.setResource(`Processor.WebsocketsProcessor`);

        websockets.perform(event, io).catch((error) => {
          Logger.error("Error processing websocket event", error, {
            event,
          });
        });
      })
    )
    .catch((err) => {
      Logger.fatal("Error starting websocketQueue", err);
    });
}

async function authenticated(
  io: IO.Server,
  socket: SocketWithAuth,
  user: User
) {
  // the rooms associated with the current team
  // and user so we can send authenticated events
  const rooms = [`team-${user.teamId}`, `user-${user.id}`];

  // the room of non-guest team members, who have access to all
  // team-visible collections.
  if (!user.isGuest) {
    rooms.push(`team-${user.teamId}.members`);
  }

  // the rooms associated with collections, groups, and chat channels this
  // user has access to on connection.
  const [collectionIds, groupIds, channelMemberships] = await Promise.all([
    user.collectionIds(),
    user.groupIds(),
    ChannelMembership.findAll({
      where: { userId: user.id },
      attributes: ["channelId"],
    }),
  ]);

  collectionIds.forEach((colId) => rooms.push(`collection-${colId}`));
  groupIds.forEach((groupId) => rooms.push(`group-${groupId}`));
  channelMemberships.forEach((m) => rooms.push(`channel-${m.channelId}`));

  // join all of the rooms at once
  await socket.join(rooms);
}

/**
 * Send a newly-connected socket a one-time snapshot of which of their
 * teammates are currently online, so the client isn't stuck showing
 * everyone as offline until each of them happens to reconnect after this
 * socket did. Checks real, cluster-wide room occupancy per teammate (the
 * same mechanism `reportOfflineIfLastConnection` uses) rather than reading
 * custom properties off `fetchSockets()` results, which aren't guaranteed
 * to carry them across instances.
 *
 * This is O(team size) Redis round-trips per new connection - fine at
 * present scale, but the first thing to revisit (e.g. a dedicated online-
 * users Redis set, updated incrementally on connect/disconnect) if the team
 * grows enough for that to matter.
 *
 * @param io The Socket.IO server.
 * @param socket The newly-connected, newly-authenticated socket.
 * @param user The authenticated user.
 */
async function sendPresenceSnapshot(
  io: IO.Server,
  socket: SocketWithAuth,
  user: User
) {
  const teammates = await User.findAll({
    where: {
      teamId: user.teamId,
      id: { [Op.ne]: user.id },
      suspendedAt: { [Op.is]: null },
    },
    attributes: ["id"],
  });

  const onlineUserIds = (
    await Promise.all(
      teammates.map(async (teammate) => {
        const sockets = await io.in(`user-${teammate.id}`).fetchSockets();
        return sockets.length > 0 ? teammate.id : null;
      })
    )
  ).filter((id): id is string => !!id);

  socket.emit("presence.snapshot", { userIds: onlineUserIds });
}

/**
 * Broadcast that a user has gone offline, but only if the socket that just
 * disconnected was their last one - a user with multiple tabs/devices open
 * should only read as "offline" once every connection has dropped. Uses
 * `fetchSockets()` (not local room state) so this is correct across
 * instances, since the Redis adapter means a user's other open tab may be
 * connected to a different process.
 *
 * @param io The Socket.IO server.
 * @param auth The disconnected socket's auth (userId, teamId).
 */
async function reportOfflineIfLastConnection(
  io: IO.Server,
  auth: { userId: string; teamId: string }
) {
  const remaining = await io.in(`user-${auth.userId}`).fetchSockets();
  if (remaining.length > 0) {
    return;
  }

  io.to(`team-${auth.teamId}`).emit("presence.offline", {
    userId: auth.userId,
  });
}

/**
 * Authenticate the socket with the given token, returning the user model and
 * attaching lightweight auth identifiers for the lifetime of the connection.
 */
async function authenticate(socket: SocketWithAuth): Promise<User> {
  const cookies = socket.request.headers.cookie
    ? cookie.parse(socket.request.headers.cookie)
    : {};
  const { accessToken } = cookies;

  if (!accessToken) {
    throw AuthenticationError("No access token");
  }

  const { user } = await getUserForJWT(accessToken);
  socket.client.auth = { userId: user.id, teamId: user.teamId };
  return user;
}
