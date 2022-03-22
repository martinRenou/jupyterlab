"""Echo WebSocket handler for real time collaboration with Yjs"""

# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

import json
import uuid
import time
from typing import Any, Dict

from tornado.ioloop import IOLoop
from jupyter_server.base.handlers import JupyterHandler
from tornado import web
from tornado.websocket import WebSocketHandler
from enum import IntEnum
import y_py as Y

## The y-protocol defines messages types that just need to be propagated to all other peers.
## Here, we define some additional messageTypes that the server can interpret.
## Messages that the server can't interpret should be broadcasted to all other clients.

class ServerMessageType(IntEnum):
    # The client is asking for a lock. Should return a lock-identifier if one is available.
    ACQUIRE_LOCK = 127
    # The client is asking to release a lock to make it available to other users again.
    RELEASE_LOCK = 126
    # The client is asking to retrieve the initial state of the Yjs document. Return an empty buffer when nothing is available.
    REQUEST_INITIALIZED_CONTENT = 125
    # The client retrieved an empty "initial content" and generated the initial state of the document after acquiring a lock. Store this.
    PUT_INITIALIZED_CONTENT = 124
    # The client moved the document to a different location. After receiving this message, we make the current document available under a different url.
    # The other clients are automatically notified of this change because the path is shared through the Yjs document as well.
    RENAME_SESSION = 123

class YjsRoom:
    def __init__(self):
        self.lock = None
        self.timeout = None
        self.lock_holder = None
        self.clients = {}
        self.content = bytes([])


class YjsEchoWebSocket(WebSocketHandler, JupyterHandler):
    rooms = {}

    # Override max_message size to 1GB
    @property
    def max_message_size(self):
        return 1024 * 1024 * 1024

    async def get(self, *args, **kwargs):
        if self.get_current_user() is None:
            self.log.warning("Couldn't authenticate WebSocket connection")
            raise web.HTTPError(403)
        return await super().get(*args, **kwargs)

    def open(self, guid):
        #print("[YJSEchoWS]: open", guid)
        cls = self.__class__
        self.awareness = Awareness(Y.YDoc(uuid.uuid4().int & (1 << 64) - 1))
        self.id = str(uuid.uuid4())
        self.room_id = guid
        room = cls.rooms.get(self.room_id)
        if room is None:
            room = YjsRoom()
            cls.rooms[self.room_id] = room
        room.clients[self.id] = ( IOLoop.current(), self.hook_send_message, self )
        # Send SyncStep1 message (based on y-protocols)
        self.write_message(bytes([0, 0, 1, 0]), binary=True)

    def on_message(self, message):
        #print("[YJSEchoWS]: message, ", message)
        cls = self.__class__
        room_id = self.room_id
        room = cls.rooms.get(room_id)
        if message[0] == ServerMessageType.ACQUIRE_LOCK:
            now = int(time.time())
            if room.lock is None or now - room.timeout > (10 * len(room.clients)) : # no lock or timeout
                room.lock = now
                room.timeout = now
                room.lock_holder = self.id
                # print('Acquired new lock: ', room.lock)
                # return acquired lock
                self.write_message(bytes([ServerMessageType.ACQUIRE_LOCK]) + room.lock.to_bytes(4, byteorder = 'little'), binary=True)

            elif room.lock_holder == self.id :
                # print('Update lock: ', room.timeout)
                room.timeout = now

        elif message[0] == ServerMessageType.RELEASE_LOCK:
            releasedLock = int.from_bytes(message[1:], byteorder = 'little')
            # print("trying release lock: ", releasedLock)
            if room.lock == releasedLock:
                # print('released lock: ', room.lock)
                room.lock = None
                room.timeout = None
                room.lock_holder = None
        elif message[0] == ServerMessageType.REQUEST_INITIALIZED_CONTENT:
            # print("client requested initial content")
            self.write_message(bytes([ServerMessageType.REQUEST_INITIALIZED_CONTENT]) + room.content, binary=True)
        elif message[0] == ServerMessageType.PUT_INITIALIZED_CONTENT:
            # print("client put initialized content")
            room.content = message[1:]
        elif message[0] == ServerMessageType.RENAME_SESSION:
            # We move the room to a different entry and also change the room_id property of each connected client
            new_room_id = message[1:].decode("utf-8")
            for client_id, (loop, hook_send_message, client) in room.clients.items() :
                client.room_id = new_room_id
            cls.rooms.pop(room_id)
            cls.rooms[new_room_id] = room
            # print("renamed room to " + new_room_id + ". Old room name was " + room_id)
        elif room:
            skip = False
            if room_id == "JupyterLab:globalAwareness":
                if message[0] == 1:
                    changes = get_awareness_changes(self.awareness, message[1:])
                    # example of awareness message filtering:
                    # if changes["removed"]:
                    #     skip = True
            if not skip:
                for client_id, (loop, hook_send_message, client) in room.clients.items() :
                    if self.id != client_id :
                        loop.add_callback(hook_send_message, message)

    def on_close(self):
        # print("[YJSEchoWS]: close")
        cls = self.__class__
        room = cls.rooms.get(self.room_id)
        room.clients.pop(self.id)
        if len(room.clients) == 0 :
            cls.rooms.pop(self.room_id)
            # print("[YJSEchoWS]: close room " + self.room_id)

        return True

    def check_origin(self, origin):
        #print("[YJSEchoWS]: check origin")
        return True

    def hook_send_message(self, msg):
        self.write_message(msg, binary=True)


class Decoder:
    def __init__(self, update: bytes):
        self.update = update
        self.i = 0
        self.length = self.read_var_uint()

    def read_var_uint(self):
        res = 0
        i = 0
        while True:
            v = self.update[self.i]
            res += (127 & v) << i
            i += 7
            self.i += 1
            if v < 128:
                break
        return res

    def read_var_string(self):
        length = self.read_var_uint()
        if length == 0:
            return ""
        return self.update[self.i:].decode("utf-8")


class Awareness:
    def __init__(self, doc):
        self.doc = doc
        self.meta = {}
        self.states = {}
        self.client_id = doc.id

    def get_local_state(self):
        return self.states.get(self.cliend_id)


def get_awareness_changes(awareness: Awareness, update: bytes) -> Dict[str, Any]:
    decoder = Decoder(update)
    timestamp = int(time.time() * 1000)
    added = []
    updated = []
    filtered_updated = []
    removed = []
    length = decoder.read_var_uint()
    for i in range(length):
        client_id = decoder.read_var_uint()
        clock = decoder.read_var_uint()
        state_str = decoder.read_var_string()
        state = None if not state_str else json.loads(state_str)
        client_meta = awareness.meta.get(client_id)
        prev_state = awareness.states.get(client_id)
        curr_clock = 0 if client_meta is None else client_meta["clock"]
        if curr_clock < clock or (curr_clock == clock and state is None and client_id in awareness.states):
            if state is None:
                if client_id == awareness.client_id and awareness.get_local_state() is not None:
                    clock += 1
                else:
                    del awareness.states[client_id]
            else:
                awareness.states[client_id] = state
            awareness.meta[client_id] = {
                "clock": clock,
                "last_updated": timestamp,
            }
            if client_meta is None and state is not None:
                added.append(client_id)
            elif client_meta is not None and state is None:
                removed.append(client_id)
            elif state is not None:
                if state != prev_state:
                    filtered_updated.append(client_id)
                updated.append(client_id)
    res = {"added": added, "updated": updated, "filtered_updated": filtered_updated, "removed": removed}
    return res
