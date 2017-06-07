// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Lang = imports.lang;
const Shell = imports.gi.Shell;

const Main = imports.ui.main;

const WorkspaceMonitor = new Lang.Class({
    Name: 'WorkspaceMonitor',

    _init: function() {
        this._shellwm = global.window_manager;
        this._shellwm.connect('minimize-completed', Lang.bind(this, this._updateOverview));
        this._shellwm.connect('destroy-completed', Lang.bind(this, this._updateOverview));

        this._metaScreen = global.screen;
        this._metaScreen.connect('in-fullscreen-changed', Lang.bind(this, this._fullscreenChanged));

        let primaryMonitor = Main.layoutManager.primaryMonitor;
        this._inFullscreen = primaryMonitor && primaryMonitor.inFullscreen;

        this._appSystem = Shell.AppSystem.get_default();
    },

    _fullscreenChanged: function() {
        let primaryMonitor = Main.layoutManager.primaryMonitor;
        let inFullscreen = primaryMonitor && primaryMonitor.inFullscreen;

        if (this._inFullscreen != inFullscreen) {
            this._inFullscreen = inFullscreen;
            this._updateOverview();
        }
    },

    _updateOverview: function() {
        let visibleApps = this._getVisibleApps();
        if (visibleApps.length == 0) {
            // Even if no apps are visible, if there is an app starting up, we
            // do not show the overview as it's likely that a window will be
            // shown. This avoids problems of windows being mapped while the
            // overview is being shown.
            if (!this._appSystem.has_starting_apps()) {
                Main.overview.showApps();
            }
        } else if (this._inFullscreen) {
            // Hide in fullscreen mode
            Main.overview.hide();
        }
    },

    _getRunningApps: function() {
        let runningApps = this._appSystem.get_running();
        return runningApps.filter(function(app) {
            let windows = app.get_windows();
            for (let window of windows) {
                // We do not count transient windows because of an issue with Audacity
                // where a transient window was always being counted as visible even
                // though it was minimized
                if (window.get_transient_for())
                    continue;

                return true;
            }

            return false;
        });
    },

    _getVisibleApps: function() {
        let runningApps = this._getRunningApps();
        return runningApps.filter(function(app) {
            let windows = app.get_windows();
            for (let window of windows) {
                if (!window.minimized)
                    return true;
            }

            return false;
        });
    },

    get hasActiveWindows() {
        // Count anything fullscreen as an extra window
        if (this._inFullscreen)
            return true;

        let apps = this._getRunningApps();
        return apps.length > 0;
    },

    get hasVisibleWindows() {
        // Count anything fullscreen as an extra window
        if (this._inFullscreen)
            return true;

        let visibleApps = this._getVisibleApps();
        return visibleApps.length > 0;
    }
});
