# Lookout in Waybar

Recording timer for your bar. Needs `python3-gi`. Copy `lookout-waybar.py`
and `lookout-menu.xml` next to your Waybar config.

`config.jsonc`:

```jsonc
"custom/lookout": {
    "exec": "~/.config/waybar/lookout-waybar.py",
    "return-type": "json",
    "format": "{icon} {}",
    "format-icons": { "recording": "<span size='75%' rise='1800'>●</span>", "paused": "⏸" },
    "menu": "on-click",
    "menu-file": "~/.config/waybar/lookout-menu.xml",
    "menu-actions": {
        "toggle": "~/.config/waybar/lookout-waybar.py toggle",
        "stop": "~/.config/waybar/lookout-waybar.py stop",
        "open": "~/.config/waybar/lookout-waybar.py open"
    }
},
```

Without extra CSS it looks like the rest of your bar. For the GNOME-style
pill, `style.css`:

```css
#custom-lookout {
    border-radius: 999px;
    padding: 0 10px;
    margin: 3px 4px;
    font-weight: bold;
}

#custom-lookout.recording {
    background: #e01b24;
    color: #ffffff;
}

#custom-lookout.paused {
    background: #f59e0b;
    color: #1c1917;
}
```

Click opens a menu: pause/resume, stop, open Lookout. Prefer direct clicks?
Drop the `menu*` keys and use `"on-click": "… toggle"`, `"on-click-right":
"… stop"`, `"on-click-middle": "… open"`.

If the text sits a pixel low in its block, that's bar-wide GTK rounding, not
the module — nudge your bar `height` by one.

For other bars: session bus, name `com.hackclub.lookout.Indicator`, path
`/com/hackclub/Lookout/Indicator`. `GetState` returns `(bsb)` (active, time,
paused), `StateChanged` signals the same, methods `Pause`/`Resume`/`Stop`/`Open`.
