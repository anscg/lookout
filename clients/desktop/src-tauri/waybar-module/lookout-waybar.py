#!/usr/bin/env python3
"""Lookout recording timer for Waybar. Setup in README.md."""

import json
import sys

import gi

gi.require_version('Gio', '2.0')
from gi.repository import Gio, GLib  # noqa: E402

BUS_NAME = 'com.hackclub.lookout.Indicator'
OBJECT_PATH = '/com/hackclub/Lookout/Indicator'
IFACE_NAME = 'com.hackclub.Lookout.Indicator'


def call(bus, method, reply_type=None):
    return bus.call_sync(BUS_NAME, OBJECT_PATH, IFACE_NAME, method, None,
                         GLib.VariantType(reply_type) if reply_type else None,
                         Gio.DBusCallFlags.NONE, 2000, None)


def subcommand(name):
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    if name == 'toggle':
        _active, _time, paused = call(bus, 'GetState', '(bsb)').unpack()
        call(bus, 'Resume' if paused else 'Pause')
    elif name in ('stop', 'open'):
        call(bus, name.capitalize())
    else:
        sys.exit(f'unknown subcommand: {name}')


def emit(active, time, paused):
    if not active:
        print(flush=True)
        return
    state = 'paused' if paused else 'recording'
    print(json.dumps({
        'text': time,
        'alt': state,
        'class': state,
        'tooltip': 'Lookout',
    }), flush=True)


def watch():
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def on_signal(_bus, _sender, _path, _iface, _signal, params, _data):
        emit(*params.unpack())

    bus.signal_subscribe(None, IFACE_NAME, 'StateChanged', OBJECT_PATH, None,
                         Gio.DBusSignalFlags.NONE, on_signal, None)

    def on_appeared(bus, _name, _owner):
        try:
            emit(*call(bus, 'GetState', '(bsb)').unpack())
        except GLib.GError:
            pass  # app quit mid-call; its vanish will hide the pill

    Gio.bus_watch_name(Gio.BusType.SESSION, BUS_NAME,
                       Gio.BusNameWatcherFlags.NONE,
                       on_appeared, lambda *_: emit(False, '', False))
    GLib.MainLoop().run()


if __name__ == '__main__':
    if len(sys.argv) > 1:
        subcommand(sys.argv[1])
    else:
        watch()
