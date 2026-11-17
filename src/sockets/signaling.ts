import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { User } from '../lib/db';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-me';

// Store active connections: email -> Set of socket IDs
const activeUsers = new Map<string, Set<string>>();
// Map socket ID -> email (for easy cleanup on disconnect)
const socketToEmail = new Map<string, string>();

// Socket ID -> what is on the other end, so a user can tell their own devices apart
export interface DeviceInfo {
  socketId: string;
  name: string;
  platform: string; // 'mobile' | 'desktop'
  connectedAt: number;
}
const deviceInfo = new Map<string, DeviceInfo>();

const sanitize = (value: any, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 40) : fallback;

export const getDevicesForEmail = (email: string, excludeSocketId?: string): DeviceInfo[] => {
  const sockets = activeUsers.get(email);
  if (!sockets) return [];
  return [...sockets]
    .filter((sId) => sId !== excludeSocketId)
    .map((sId) => deviceInfo.get(sId) || { socketId: sId, name: 'Unknown device', platform: 'desktop', connectedAt: 0 })
    .sort((a, b) => a.connectedAt - b.connectedAt);
};

/**
 * Connection requests waiting for an answer, by the requesting socket. A request to another
 * account goes to every device signed in there; the first to accept takes it.
 */
interface PendingOffer {
  senderEmail: string;
  targets: Set<string>;
  /** The device that accepted, once one has. */
  takenBy?: string;
}
const pendingOffers = new Map<string, PendingOffer>();

export const getActiveConnectionsCount = (email: string): number => {
  return activeUsers.get(email)?.size || 0;
};


export const setupSignalingSockets = (io: Server) => {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }
    try {
      const payload = jwt.verify(token, JWT_SECRET) as { userId: string, email: string };
      (socket as any).user = payload;
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', async (socket: Socket) => {
    const user = (socket as any).user;
    const email = user.email;

    console.log(`User connected: ${email} (Socket ID: ${socket.id})`);

    // Add to active users
    if (!activeUsers.has(email)) {
      activeUsers.set(email, new Set());
    }
    activeUsers.get(email)!.add(socket.id);
    socketToEmail.set(socket.id, email);

    const device = (socket.handshake.auth as any)?.device || {};
    deviceInfo.set(socket.id, {
      socketId: socket.id,
      name: sanitize(device.name, 'Unknown device'),
      platform: sanitize(device.platform, 'desktop'),
      connectedAt: Date.now(),
    });

    // Every device of this account gets the list minus itself, so open pickers stay current
    const broadcastDeviceList = (targetEmail: string) => {
      const sockets = activeUsers.get(targetEmail);
      if (!sockets) return;
      for (const sId of sockets) {
        io.to(sId).emit('devices-updated', getDevicesForEmail(targetEmail, sId));
      }
    };
    broadcastDeviceList(email);

    socket.on('list-devices', (cb?: (devices: DeviceInfo[]) => void) => {
      const devices = getDevicesForEmail(email, socket.id);
      if (typeof cb === 'function') cb(devices);
      socket.emit('devices-updated', devices);
    });

    // Signaling events
    /** Withdraws this socket's open request from the devices it went to. */
    const cancelOwnOffer = () => {
      const pending = pendingOffers.get(socket.id);
      if (!pending) return;
      pendingOffers.delete(socket.id);
      if (pending.takenBy) return;
      for (const sId of pending.targets) io.to(sId).emit('webrtc-offer-cancelled', { senderSocketId: socket.id });
    };

    socket.on('webrtc-offer', ({ targetEmail, targetSocketId, offer, senderProfile }) => {
      const targetSockets = activeUsers.get(targetEmail);
      // A new request replaces this socket's earlier one.
      cancelOwnOffer();
      if (!targetSockets) return;

      let targets: string[] = [];
      if (targetSocketId && targetSockets.has(targetSocketId) && targetSocketId !== socket.id) {
        // A chosen device
        targets = [targetSocketId];
      } else if (targetEmail !== email) {
        // Someone else's account: every device signed in there can accept
        targets = [...targetSockets];
      } else {
        // My own account, no device chosen: the first other one
        const first = [...targetSockets].find((sId) => sId !== socket.id);
        if (first) targets = [first];
      }
      targets = targets.filter((sId) => sId !== socket.id);
      if (targets.length === 0) return;

      pendingOffers.set(socket.id, { senderEmail: email, targets: new Set(targets) });
      for (const sId of targets) {
        io.to(sId).emit('webrtc-offer', {
          senderEmail: email,
          senderProfile,
          senderSocketId: socket.id,
          offer
        });
      }
    });

    // The requester gave up (left, or started over)
    socket.on('webrtc-cancel-offer', () => cancelOwnOffer());

    socket.on('webrtc-reject', ({ targetSocketId }) => {
      if (!targetSocketId) return;
      const pending = pendingOffers.get(targetSocketId);
      if (pending && pending.targets.has(socket.id) && !pending.takenBy) {
        // One device said no; the request stays open on the others until all have.
        pending.targets.delete(socket.id);
        if (pending.targets.size > 0) return;
        pendingOffers.delete(targetSocketId);
      }
      io.to(targetSocketId).emit('webrtc-reject', {
        senderEmail: email
      });
    });

    socket.on('webrtc-answer', ({ targetEmail, targetSocketId, answer }) => {
      const pending = targetSocketId ? pendingOffers.get(targetSocketId) : undefined;
      if (pending) {
        if (pending.takenBy && pending.takenBy !== socket.id) {
          // Another device accepted first: this one backs out.
          socket.emit('webrtc-offer-taken', { senderSocketId: targetSocketId, senderEmail: pending.senderEmail });
          return;
        }
        if (!pending.takenBy) {
          pending.takenBy = socket.id;
          for (const sId of pending.targets) {
            if (sId !== socket.id) {
              io.to(sId).emit('webrtc-offer-taken', { senderSocketId: targetSocketId, senderEmail: pending.senderEmail });
            }
          }
        }
      }
      let socketIdToSend = targetSocketId;
      if (!socketIdToSend && targetEmail) {
        const targetSockets = activeUsers.get(targetEmail);
        if (targetSockets) {
          for (const sId of targetSockets) {
            if (sId !== socket.id) {
              socketIdToSend = sId;
              break;
            }
          }
        }
      }

      if (socketIdToSend) {
        io.to(socketIdToSend).emit('webrtc-answer', {
          senderEmail: email,
          senderSocketId: socket.id,
          answer
        });
      }
    });

    socket.on('webrtc-ice-candidate', ({ targetEmail, targetSocketId, candidate }) => {
      // Before anyone accepts, the requester doesn't know which device will: send to all it asked.
      const pending = !targetSocketId ? pendingOffers.get(socket.id) : undefined;
      if (pending) {
        const to = pending.takenBy ? [pending.takenBy] : [...pending.targets];
        for (const sId of to) {
          io.to(sId).emit('webrtc-ice-candidate', { senderEmail: email, senderSocketId: socket.id, candidate });
        }
        return;
      }
      let socketIdToSend = targetSocketId;
      if (!socketIdToSend && targetEmail) {
        const targetSockets = activeUsers.get(targetEmail);
        if (targetSockets) {
          for (const sId of targetSockets) {
            if (sId !== socket.id) {
              socketIdToSend = sId;
              break;
            }
          }
        }
      }

      if (socketIdToSend) {
        io.to(socketIdToSend).emit('webrtc-ice-candidate', {
          senderEmail: email,
          senderSocketId: socket.id,
          candidate
        });
      }
    });

    socket.on('check-presence', (emails: string[]) => {
      const presence: Record<string, boolean> = {};
      emails.forEach(e => {
        // If checking own email, we want to know if there are *other* devices, so count > 1
        // If checking another email, count > 0
        const count = getActiveConnectionsCount(e);
        if (e === email) {
          presence[e] = count > 1;
        } else {
          presence[e] = count > 0;
        }
      });
      socket.emit('presence-result', presence);
    });

    socket.on('user-profile-updated', (userData: any) => {
      const userSockets = activeUsers.get(email);
      if (userSockets) {
        for (const sId of userSockets) {
          if (sId !== socket.id) {
            io.to(sId).emit('user-profile-updated', userData);
          }
        }
      }
    });

    socket.on('disconnect', () => {
      console.log(`User disconnected: ${email} (Socket ID: ${socket.id})`);
      const userSockets = activeUsers.get(email);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          activeUsers.delete(email);
        }
      }
      socketToEmail.delete(socket.id);
      deviceInfo.delete(socket.id);
      // Its own request is withdrawn; a request it was one of the targets of loses it
      cancelOwnOffer();
      for (const [senderId, pending] of pendingOffers) {
        if (!pending.targets.delete(socket.id) || pending.takenBy) continue;
        if (pending.targets.size === 0) {
          pendingOffers.delete(senderId);
          io.to(senderId).emit('webrtc-reject', { senderEmail: email });
        }
      }
      broadcastDeviceList(email);
    });
  });
};
