// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Lang = imports.lang;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Tweener = imports.ui.tweener;

const AppActivation = imports.ui.appActivation;
const AppFavorites = imports.ui.appFavorites;
const BoxPointer = imports.ui.boxpointer;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const MAX_OPACITY = 255;
const MAX_ANGLE = 360;

const ICON_SIZE = 24;
const NAV_BUTTON_SIZE = 15;

const ICON_SCROLL_ANIMATION_TIME = 0.3;
const ICON_SCROLL_ANIMATION_TYPE = 'linear';

const ICON_BOUNCE_MAX_SCALE = 0.4;
const ICON_BOUNCE_ANIMATION_TIME = 0.4;
const ICON_BOUNCE_ANIMATION_TYPE_1 = 'easeOutSine';
const ICON_BOUNCE_ANIMATION_TYPE_2 = 'easeOutBounce';

const PANEL_WINDOW_MENU_THUMBNAIL_SIZE = 128;

const SHELL_KEYBINDINGS_SCHEMA = 'org.gnome.shell.keybindings';

function _compareByStableSequence(winA, winB) {
    let seqA = winA.get_stable_sequence();
    let seqB = winB.get_stable_sequence();

    return seqA - seqB;
}

const WindowMenuItem = new Lang.Class({
    Name: 'WindowMenuItem',
    Extends: PopupMenu.PopupBaseMenuItem,

    _init: function (window, params) {
        this.parent(params);

        this.window = window;

        this.actor.add_style_class_name('panel-window-menu-item');

        let windowActor = this._findWindowActor();
        let monitor = Main.layoutManager.primaryMonitor;

        // constraint the max size of the clone to the aspect ratio
        // of the primary display, where the panel lives
        let ratio = monitor.width / monitor.height;
        let maxW = (ratio > 1) ?
            PANEL_WINDOW_MENU_THUMBNAIL_SIZE : PANEL_WINDOW_MENU_THUMBNAIL_SIZE * ratio;
        let maxH = (ratio > 1) ?
            PANEL_WINDOW_MENU_THUMBNAIL_SIZE / ratio : PANEL_WINDOW_MENU_THUMBNAIL_SIZE;

        let clone = new Clutter.Clone({ source: windowActor.get_texture() });
        let cloneW = clone.width;
        let cloneH = clone.height;
        let scale = Math.min(maxW / cloneW, maxH / cloneH);
        clone.set_size(Math.round(cloneW * scale), Math.round(cloneH * scale));

        this.cloneBin = new St.Bin({ child: clone,
                                     style_class: 'panel-window-menu-item-clone' });
        this.actor.add_child(this.cloneBin, { align: St.Align.MIDDLE });

        this.label = new St.Label({ text: window.title,
                                    style_class: 'panel-window-menu-item-label' });

        this.actor.add_child(this.label);
        this.actor.label_actor = this.label;
    },

    _findWindowActor: function() {
        let actors = global.get_window_actors();
        let windowActors = actors.filter(Lang.bind(this, function(actor) {
            return actor.meta_window == this.window;
        }));

        return windowActors[0];
    }
});

const ScrollMenuItem = new Lang.Class({
    Name: 'ScrollMenuItem',
    Extends: PopupMenu.PopupSubMenuMenuItem,

    _init: function() {
        this.parent('');

        // remove all the stock style classes
        this.actor.remove_style_class_name('popup-submenu-menu-item');
        this.actor.remove_style_class_name('popup-menu-item');

        // remove all the stock actors
        this.actor.remove_all_children();
        this.menu.destroy();

        this.label = null;
        this._triangle = null;

        this.menu = new PopupMenu.PopupSubMenu(this.actor, new St.Label({ text: '' }));
        this.menu.actor.remove_style_class_name('popup-sub-menu');
    },

    _onKeyPressEvent: function(actor, event) {
        // no special handling
        return false;
    },

    activate: function(event) {
        // override to do nothing
    },

    _onButtonReleaseEvent: function(actor) {
        // override to do nothing
    }
});

const APP_ICON_MENU_ARROW_XALIGN = 0.5;

const AppIconMenu = new Lang.Class({
    Name: 'AppIconMenu',
    Extends: PopupMenu.PopupMenu,

    _init: function(app, parentActor) {
        this.parent(parentActor, APP_ICON_MENU_ARROW_XALIGN, St.Side.BOTTOM);

        this.actor.add_style_class_name('app-icon-menu');

        this._submenuItem = new ScrollMenuItem();
        this.addMenuItem(this._submenuItem);
        this._submenuItem.menu.connect('activate', Lang.bind(this, this._onActivate));

        // We want to popdown the menu when clicked on the source icon itself
        this.shouldSwitchToOnHover = false;

        this._app = app;

        // Chain our visibility and lifecycle to that of the source
        parentActor.connect('notify::mapped', Lang.bind(this, function () {
            if (!parentActor.mapped)
                this.close();
        }));
        parentActor.connect('destroy', Lang.bind(this, function () { this.actor.destroy(); }));
    },

    _redisplay: function() {
        this._submenuItem.menu.removeAll();

        let activeWorkspace = global.screen.get_active_workspace();

        let windows = this._app.get_windows();
        let workspaceWindows = [];
        let otherWindows = [];

        windows.forEach(function(w) {
            if (w.is_skip_taskbar() || Shell.WindowTracker.is_speedwagon_window(w))
                return;

            if (w.located_on_workspace(activeWorkspace))
                workspaceWindows.push(w);
            else
                otherWindows.push(w);
        });

        workspaceWindows.sort(Lang.bind(this, _compareByStableSequence));
        otherWindows.sort(Lang.bind(this, _compareByStableSequence));

        let hasWorkspaceWindows = (workspaceWindows.length > 0);
        let hasOtherWindows = (otherWindows.length > 0);

        // Display windows from other workspaces first, if present, since our panel
        // is at the bottom, and it's much more convenient to just move up the pointer
        // to switch windows in the current workspace
        if (hasOtherWindows)
            this._appendOtherWorkspacesLabel();

        otherWindows.forEach(Lang.bind(this, function(w) {
            this._appendMenuItem(w, hasOtherWindows);
        }));

        if (hasOtherWindows && hasWorkspaceWindows)
            this._appendCurrentWorkspaceSeparator();

        workspaceWindows.forEach(Lang.bind(this, function(w) {
            this._appendMenuItem(w, hasOtherWindows);
        }));
    },

    _appendOtherWorkspacesLabel: function () {
        let label = new PopupMenu.PopupMenuItem(_("Other workspaces"));
        label.label.add_style_class_name('panel-window-menu-workspace-label');
        this._submenuItem.menu.addMenuItem(label);
    },

    _appendCurrentWorkspaceSeparator: function () {
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this._submenuItem.menu.addMenuItem(separator);

        let label = new PopupMenu.PopupMenuItem(_("Current workspace"));
        label.label.add_style_class_name('panel-window-menu-workspace-label');
        this._submenuItem.menu.addMenuItem(label);
    },

    _appendMenuItem: function(window, hasOtherWindows) {
        let item = new WindowMenuItem(window);
        this._submenuItem.menu.addMenuItem(item);

        if (hasOtherWindows)
            item.cloneBin.add_style_pseudo_class('indented');
    },

    toggle: function(animation) {
        if (this.isOpen) {
            this.close(animation);
        } else {
            this._redisplay();
            this.open(animation);
            this._submenuItem.menu.open(BoxPointer.PopupAnimation.NONE);
        }
    },

    _onActivate: function (actor, item) {
        Main.activateWindow(item.window);
        this.close();
    }
});

/** AppIconButton:
 *
 * This class handles the application icon
 */
const AppIconButton = new Lang.Class({
    Name: 'AppIconButton',

    _init: function(app, iconSize, menuManager, allowsPinning) {
        this._app = app;

        this._iconSize = iconSize;
        let icon = this._createIcon();

        this._menuManager = menuManager;

        this.actor = new St.Button({ style_class: 'app-icon-button',
                                     child: icon,
                                     button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
                                     reactive: true });

        this._label = new St.Label({ text: this._app.get_name(),
                                     style_class: 'app-icon-hover-label' });
        this._label.connect('style-changed', Lang.bind(this, this._updateStyle));

        // Handle the menu-on-press case for multiple windows
        this.actor.connect('button-press-event', Lang.bind(this, this._handleButtonPressEvent));
        this.actor.connect('clicked', Lang.bind(this, this._handleClickEvent));

        Main.layoutManager.connect('startup-complete', Lang.bind(this, this._updateIconGeometry));
        this.actor.connect('notify::allocation', Lang.bind(this, this._updateIconGeometry));
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));
        this.actor.connect('enter-event', Lang.bind(this, this._showHoverState));
        this.actor.connect('leave-event', Lang.bind(this, this._hideHoverState));

        this._rightClickMenuManager = new PopupMenu.PopupMenuManager(this);

        this._rightClickMenu = new PopupMenu.PopupMenu(this.actor, 0.0, St.Side.TOP, 0);
        this._rightClickMenu.blockSourceEvents = true;

        if (allowsPinning) {
            this._pinMenuItem = this._rightClickMenu.addAction(_("Pin to Taskbar"), Lang.bind(this, function() {
                this.emit('app-icon-pinned');
            }));

            this._unpinMenuItem = this._rightClickMenu.addAction(_("Unpin from Taskbar"), Lang.bind(this, function() {
                this.emit('app-icon-unpinned');
            }));

            if (AppFavorites.getAppFavorites().isFavorite(this._app.get_id()))
                this._pinMenuItem.actor.visible = false;
            else
                this._unpinMenuItem.actor.visible = false;

            this._rightClickMenu.connect('menu-closed', Lang.bind(this, function() {
                let isPinned = AppFavorites.getAppFavorites().isFavorite(this._app.get_id());
                this._pinMenuItem.actor.visible = !isPinned;
                this._unpinMenuItem.actor.visible = isPinned;
            }));
        }

        this._quitMenuItem = this._rightClickMenu.addAction(_("Quit %s").format(this._app.get_name()), Lang.bind(this, function() {
            this._app.request_quit();
        }));
        this._rightClickMenuManager.addMenu(this._rightClickMenu);
        this._rightClickMenu.actor.hide();
        Main.uiGroup.add_actor(this._rightClickMenu.actor);

        this._menu = new AppIconMenu(this._app, this.actor);
        this._menuManager.addMenu(this._menu);
        this._menu.actor.hide();
        Main.uiGroup.add_actor(this._menu.actor);

        this._menu.connect('open-state-changed', Lang.bind(this, function(menu, open) {
            // Setting the max-height won't do any good if the minimum height of the
            // menu is higher then the screen; it's useful if part of the menu is
            // scrollable so the minimum height is smaller than the natural height
            let workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            this._menu.actor.style = ('max-height: ' + Math.round(workArea.height) + 'px;');
        }));

        this._appStateUpdatedId = this._app.connect('notify::state', Lang.bind(this, this._syncQuitMenuItemVisible));
        this._syncQuitMenuItemVisible();
    },

    _syncQuitMenuItemVisible: function() {
        let visible = (this._app.get_state() == Shell.AppState.RUNNING);
        this._quitMenuItem.actor.visible = visible;
    },

    _createIcon: function() {
        return this._app.create_icon_texture(this._iconSize);
    },

    _hasOtherMenuOpen: function() {
        let activeIconMenu = this._menuManager.activeMenu;
        return (activeIconMenu &&
                activeIconMenu != this._menu &&
                activeIconMenu.isOpen);
    },

    _closeOtherMenus: function(animation) {
        // close any other open menu
        if (this._hasOtherMenuOpen())
            this._menuManager.activeMenu.toggle(animation);
    },

    _getInterestingWindows: function() {
        let windows = this._app.get_windows();
        let hasSpeedwagon = false;
        windows = windows.filter(function(metaWindow) {
            hasSpeedwagon = hasSpeedwagon || Shell.WindowTracker.is_speedwagon_window(metaWindow);
            return !metaWindow.is_skip_taskbar();
        });
        return [windows, hasSpeedwagon];
    },

    _getNumRealWindows: function(windows, hasSpeedwagon) {
        return windows.length - (hasSpeedwagon ? 1 : 0);
    },

    _handleButtonPressEvent: function(actor, event) {
        let button = event.get_button();
        let clickCount = event.get_click_count();

        if (button == Gdk.BUTTON_PRIMARY &&
            clickCount == 1) {
            this._hideHoverState();
            this.emit('app-icon-pressed');

            let [windows, hasSpeedwagon] = this._getInterestingWindows();
            let numRealWindows = this._getNumRealWindows(windows, hasSpeedwagon);

            if (numRealWindows > 1) {
                let hasOtherMenu = this._hasOtherMenuOpen();
                let animation = BoxPointer.PopupAnimation.FULL;
                if (hasOtherMenu)
                    animation = BoxPointer.PopupAnimation.NONE;

                this._closeOtherMenus(animation);
                this._animateBounce();

                this.actor.fake_release();
                this._menu.toggle(animation);
                this._menuManager.ignoreRelease();

                // This will block the clicked signal from being emitted
                return true;
            }
        }

        this.actor.sync_hover();
        return false;
    },

    _handleClickEvent: function() {
        let event = Clutter.get_current_event();
        let button = event.get_button();

        if (button == Gdk.BUTTON_SECONDARY) {
            this._hideHoverState();

            this._closeOtherMenus(BoxPointer.PopupAnimation.FULL);
            if (this._menu.isOpen)
                this._menu.toggle(BoxPointer.PopupAnimation.FULL);

            this._rightClickMenu.open();
            return;
        }

        let hasOtherMenu = this._hasOtherMenuOpen();
        this._closeOtherMenus(BoxPointer.PopupAnimation.FULL);
        this._animateBounce();

        let [windows, hasSpeedwagon] = this._getInterestingWindows();
        let numRealWindows = this._getNumRealWindows(windows, hasSpeedwagon);

        // The multiple windows case is handled in button-press-event
        if (windows.length == 0) {
            let activationContext = new AppActivation.AppActivationContext(this._app);
            activationContext.activate();
        } else if (numRealWindows == 1 && !hasSpeedwagon) {
            let win = windows[0];
            if (win.has_focus() && !Main.overview.visible && !hasOtherMenu) {
                // The overview is not visible, and this is the
                // currently focused application; minimize it
                win.minimize();
            } else {
                // Activate window normally
                Main.activateWindow(win);
            }
        }
    },

    activateFirstWindow: function() {
        this._animateBounce();
        this._closeOtherMenus(BoxPointer.PopupAnimation.FULL);
        let windows = this._getInterestingWindows()[0];
        if (windows.length > 0) {
            Main.activateWindow(windows[0]);
        } else {
            let activationContext = new AppActivation.AppActivationContext(this._app);
            activationContext.activate();
        }
    },

    _hideHoverState: function() {
        this.actor.fake_release();
        if (this._label.get_parent() != null)
            Main.uiGroup.remove_actor(this._label);
    },

    _showHoverState: function() {
        // Show label only if it's not already visible
        this.actor.fake_release();
        if (this._label.get_parent())
            return;

        Main.uiGroup.add_actor(this._label);
        this._label.raise_top();

        // Calculate location of the label only if we're not tweening as the
        // values will be inaccurate
        if (!Tweener.isTweening(this.actor)) {
            let iconMidpoint = this.actor.get_transformed_position()[0] + this.actor.width / 2;
            this._label.translation_x = Math.floor(iconMidpoint - this._label.width / 2);
            this._label.translation_y = Math.floor(this.actor.get_transformed_position()[1] - this._labelOffsetY);

            // Clip left edge to be the left edge of the screen
            this._label.translation_x = Math.max(this._label.translation_x, 0);
        }
    },

    _animateBounce: function() {
        if (!Tweener.isTweening(this.actor)) {
            Tweener.addTween(this.actor, {
                scale_y: 1 - ICON_BOUNCE_MAX_SCALE,
                scale_x: 1 + ICON_BOUNCE_MAX_SCALE,
                translation_y: this.actor.height * ICON_BOUNCE_MAX_SCALE,
                translation_x: -this.actor.width * ICON_BOUNCE_MAX_SCALE / 2,
                time: ICON_BOUNCE_ANIMATION_TIME * 0.25,
                transition: ICON_BOUNCE_ANIMATION_TYPE_1
            });
            Tweener.addTween(this.actor, {
                scale_y: 1,
                scale_x: 1,
                translation_y: 0,
                translation_x: 0,
                time: ICON_BOUNCE_ANIMATION_TIME * 0.75,
                transition: ICON_BOUNCE_ANIMATION_TYPE_2,
                delay: ICON_BOUNCE_ANIMATION_TIME * 0.25
            });
        }
    },

    setIconSize: function(iconSize) {
        let icon = this._app.create_icon_texture(iconSize);
        this._iconSize = iconSize;

        this.actor.set_child(icon);
    },

    _onDestroy: function() {
        this._label.destroy();
        this._resetIconGeometry();

        if (this._appStateUpdatedId > 0) {
            this._app.disconnect(this._appStateUpdatedId);
            this._appStateUpdatedId = 0;
        }
    },

    _setIconRectForAllWindows: function(rectangle) {
        let windows = this._app.get_windows();
        windows.forEach(Lang.bind(this, function(win) {
            win.set_icon_geometry(rectangle);
        }));
    },

    _resetIconGeometry: function() {
        this._setIconRectForAllWindows(null);
    },

    _updateIconGeometry: function() {
        if (!this.actor.mapped)
            return;

        let rect = new Meta.Rectangle();
        [rect.x, rect.y] = this.actor.get_transformed_position();
        [rect.width, rect.height] = this.actor.get_transformed_size();

        this._setIconRectForAllWindows(rect);
    },

    _updateStyle: function(actor, forHeight, alloc) {
        this._labelOffsetY = this._label.get_theme_node().get_length('-label-offset-y');
    },

    isPinned: function() {
        return AppFavorites.getAppFavorites().isFavorite(this._app.get_id());
    }
});
Signals.addSignalMethods(AppIconButton.prototype);

/** AppIconBarNavButton:
 *
 * This class handles the nav buttons on the app bar
 */
const AppIconBarNavButton = Lang.Class({
    Name: 'AppIconBarNavButton',
    Extends: St.Button,

    _init: function(iconName) {
        this._icon = new St.Icon({ style_class: 'app-bar-nav-icon',
                                   icon_name: iconName });

        this.parent({ style_class: 'app-bar-nav-button',
                      child: this._icon,
                      can_focus: true,
                      reactive: true,
                      track_hover: true,
                      button_mask: St.ButtonMask.ONE });
    }
});


const ScrolledIconList = new Lang.Class({
    Name: 'ScrolledIconList',

    _init: function(menuManager) {
        this.actor = new St.ScrollView({ hscrollbar_policy: Gtk.PolicyType.NEVER,
                                         style_class: 'scrolled-icon-list hfade',
                                         vscrollbar_policy: Gtk.PolicyType.NEVER,
                                         x_fill: true,
                                         y_fill: true });

        this._menuManager = menuManager;

        // Due to the interactions with StScrollView,
        // StBoxLayout clips its painting to the content box, effectively
        // clipping out the side paddings we want to set on the actual icons
        // container. We need to go through some hoops and set the padding
        // on an intermediate spacer child instead
        let scrollChild = new St.BoxLayout();
        this.actor.add_actor(scrollChild);

        this._spacerBin = new St.Widget({ style_class: 'scrolled-icon-spacer',
                                          layout_manager: new Clutter.BinLayout() });
        scrollChild.add_actor(this._spacerBin);

        this._container = new St.BoxLayout({ style_class: 'scrolled-icon-container',
                                             x_expand: true,
                                             y_expand: true });
        this._spacerBin.add_actor(this._container);

        this._iconSize = ICON_SIZE;
        this._iconSpacing = 0;

        this._iconOffset = 0;
        this._appsPerPage = -1;

        this._container.connect('style-changed', Lang.bind(this, this._updateStyleConstants));

        let appSys = Shell.AppSystem.get_default();
        this._taskbarApps = new Map();

        // Update for any apps running before the system started
        // (after a crash or a restart)
        let currentlyRunning = appSys.get_running();
        let appsByPid = [];
        for (let i = 0; i < currentlyRunning.length; i++) {
            let app = currentlyRunning[i];
            // Most apps have a single PID; ignore all but the first
            let pid = app.get_pids()[0];
            appsByPid.push({ pid: pid,
                             app: app });
        }

        let favorites = AppFavorites.getAppFavorites().getFavorites();
        for (let i = 0; i < favorites.length; i++) {
            this._addButtonAnimated(favorites[i]);
        }

        // Sort numerically by PID
        // This preserves the original app order, until the maximum PID
        // value is reached and older PID values are recycled
        let sortedPids = appsByPid.sort(function(a, b) { return a.pid - b.pid; });
        for (let i = 0; i < sortedPids.length; i++) {
            let app = sortedPids[i].app;
            this._addButtonAnimated(app);
        }

        appSys.connect('app-state-changed', Lang.bind(this, this._onAppStateChanged));
    },

    setActiveApp: function(app) {
        this._taskbarApps.forEach(Lang.bind(this, function(appButton, taskbarApp) {
            if (app == taskbarApp)
                appButton.actor.add_style_pseudo_class('highlighted');
            else
                appButton.actor.remove_style_pseudo_class('highlighted');
        }));
    },

    getNumAppButtons: function() {
        return this._taskbarApps.size;
    },

    activateNthApp: function(index) {
        let buttons = [...this._taskbarApps.values()];
        let appButton = buttons[index];
        if (appButton)
            appButton.activateFirstWindow();
    },

    getMinContentWidth: function(forHeight) {
        // We always want to show one icon, plus we want to keep the padding
        // added by the spacer actor
        let [minSpacerWidth, ] = this._spacerBin.get_preferred_width(forHeight);
        let [minContainerWidth, ] = this._container.get_preferred_width(forHeight);
        return this._iconSize + (minSpacerWidth - minContainerWidth);
    },

    _updatePage: function() {
        // Clip the values of the iconOffset
        let lastIconOffset = this._taskbarApps.size - 1;
        let movableIconsPerPage = this._appsPerPage - 1;
        let iconOffset = Math.max(0, this._iconOffset);
        iconOffset = Math.min(lastIconOffset - movableIconsPerPage, iconOffset);

        if (this._iconOffset == iconOffset)
            return;

        this._iconOffset = iconOffset;

        let relativeAnimationTime = ICON_SCROLL_ANIMATION_TIME;

        let iconFullWidth = this._iconSize + this._iconSpacing;
        let pageSize = this._appsPerPage * iconFullWidth;
        let hadjustment = this.actor.hscroll.adjustment;

        let currentOffset = this.actor.hscroll.adjustment.get_value();
        let targetOffset = Math.min(this._iconOffset * iconFullWidth, hadjustment.upper);

        let distanceToTravel = Math.abs(targetOffset - currentOffset);
        if (distanceToTravel < pageSize)
            relativeAnimationTime = relativeAnimationTime * distanceToTravel / pageSize;

        Tweener.addTween(hadjustment, { value: targetOffset,
                                        time: relativeAnimationTime,
                                        transition: ICON_SCROLL_ANIMATION_TYPE });
        this.emit('icons-scrolled');
    },

    pageBack: function() {
        this._iconOffset -= this._appsPerPage - 1;
        this._updatePage();
    },

    pageForward: function() {
        this._iconOffset += this._appsPerPage - 1;
        this._updatePage();
    },

    isBackAllowed: function() {
        return this._iconOffset > 0;
    },

    isForwardAllowed: function() {
        return this._iconOffset < this._taskbarApps.size - this._appsPerPage;
    },

    calculateNaturalSize: function(forWidth) {
        let [numOfPages, appsPerPage] = this._calculateNumberOfPages(forWidth);

        if (this._appsPerPage != appsPerPage || this._numberOfPages != numOfPages) {
            this._appsPerPage = appsPerPage;
            this._numberOfPages = numOfPages;

            this._updatePage();
        }

        let iconFullSize = this._iconSize + this._iconSpacing;
        return this._appsPerPage * iconFullSize - this._iconSpacing;
    },

    _updateStyleConstants: function() {
        let node = this._container.get_theme_node();

        this._iconSize = node.get_length('-icon-size');
        this._taskbarApps.forEach(Lang.bind(this, function(appButton, app) {
            appButton.setIconSize(this._iconSize);
        }));

        this._iconSpacing = node.get_length('spacing');
    },

    _ensureIsVisible: function(app) {
        let apps = [...this._taskbarApps.keys()];
        let itemIndex = apps.indexOf(app);
        if (itemIndex != -1)
            this._iconOffset = itemIndex;

        this._updatePage();
    },

    _isAppInteresting: function(app) {
        if (AppFavorites.getAppFavorites().isFavorite(app.get_id()))
            return true;

        if (app.state == Shell.AppState.STARTING)
            return true;

        if (app.state == Shell.AppState.RUNNING) {
            let windows = app.get_windows();
            return windows.some(function(metaWindow) {
                return !metaWindow.is_skip_taskbar();
            });
        }

        return false;
    },

    _getIconButtonForActor: function(actor) {
        for (let appIconButton of this._taskbarApps.values()) {
            if (appIconButton != null && appIconButton.actor == actor)
                return appIconButton;
        }
        return null;
    },

    _countPinnedAppsAheadOf: function(button) {
        let count = 0;
        let actors = this._container.get_children();
        for (let i = 0; i < actors.length; i++) {
            let otherButton = this._getIconButtonForActor(actors[i]);
            if (otherButton == button)
                return count;
            if (otherButton != null && otherButton.isPinned())
                count++;
        }
        return -1;
    },

    _addButtonAnimated: function(app) {
        if (this._taskbarApps.has(app) || !this._isAppInteresting(app))
            return;

        let favorites = AppFavorites.getAppFavorites();
        let newChild = new AppIconButton(app, this._iconSize, this._menuManager, true);
        let newActor = newChild.actor;

        newChild.connect('app-icon-pressed', Lang.bind(this, function() {
            this.emit('app-icon-pressed');
        }));
        newChild.connect('app-icon-pinned', Lang.bind(this, function() {
            favorites.addFavoriteAtPos(app.get_id(), this._countPinnedAppsAheadOf(newChild));
        }));
        newChild.connect('app-icon-unpinned', Lang.bind(this, function() {
            favorites.removeFavorite(app.get_id());
            if (app.state == Shell.AppState.STOPPED) {
                newActor.destroy();
                this._taskbarApps.delete(app);
                this._updatePage();
            }
        }));
        this._taskbarApps.set(app, newChild);

        this._container.add_actor(newActor);
    },

    _addButton: function(app) {
        this._addButtonAnimated(app);
    },

    _onAppStateChanged: function(appSys, app) {
        let state = app.state;
        switch(state) {
        case Shell.AppState.STARTING:
        case Shell.AppState.RUNNING:
            this._addButton(app);
            this._ensureIsVisible(app);
            break;

        case Shell.AppState.STOPPED:
            if (AppFavorites.getAppFavorites().isFavorite(app.get_id()))
                break;

            let oldChild = this._taskbarApps.get(app);
            if (oldChild) {
                oldChild.actor.destroy();
                this._taskbarApps.delete(app);
            }
            break;
        }

        this._updatePage();
    },

    _calculateNumberOfPages: function(forWidth){
        let minimumIconWidth = this._iconSize + this._iconSpacing;

        // We need to add one icon space to net width here so that the division
        // takes into account the fact that the last icon does not use iconSpacing
        let iconsPerPage = Math.floor((forWidth + this._iconSpacing) / minimumIconWidth);
        iconsPerPage = Math.max(1, iconsPerPage);

        let pages = Math.ceil(this._taskbarApps.size / iconsPerPage);
        return [pages, iconsPerPage];
    }
});
Signals.addSignalMethods(ScrolledIconList.prototype);

/** AppIconBar:
 *
 * This class handles positioning all the application icons and listening
 * for app state change signals
 */
const AppIconBar = new Lang.Class({
    Name: 'AppIconBar',
    Extends: PanelMenu.Button,

    _init: function(panel) {
        this.parent(0.0, null, true);
        this.actor.add_style_class_name('app-icon-bar');

        this._panel = panel;
        this._spacing = 0;

        this._menuManager = new PopupMenu.PopupMenuManager(this);

        let bin = new St.Bin({ name: 'appIconBar',
                               x_fill: true });
        this.actor.add_actor(bin);

        this._container = new Shell.GenericContainer({ name: 'appIconBarContainer' });
        this._container.connect('style-changed', Lang.bind(this, this._updateStyleConstants));

        bin.set_child(this._container);
        this._container.connect('get-preferred-width', Lang.bind(this, this._getContentPreferredWidth));
        this._container.connect('get-preferred-height', Lang.bind(this, this._getContentPreferredHeight));
        this._container.connect('allocate', Lang.bind(this, this._contentAllocate));

        this._backButton = new AppIconBarNavButton('go-previous-symbolic');
        this._backButton.connect('clicked', Lang.bind(this, this._previousPageSelected));
        this._container.add_actor(this._backButton);

        this._scrolledIconList = new ScrolledIconList(this._menuManager);
        this._container.add_actor(this._scrolledIconList.actor);

        this._forwardButton = new AppIconBarNavButton('go-next-symbolic');
        this._forwardButton.connect('clicked', Lang.bind(this, this._nextPageSelected));
        this._container.add_actor(this._forwardButton);

        this._scrolledIconList.connect('icons-scrolled', Lang.bind(this, function() {
            this._container.queue_relayout();
        }));
        this._scrolledIconList.connect('app-icon-pressed', Lang.bind(this, this._onAppIconPressed));

        this._windowTracker = Shell.WindowTracker.get_default();
        this._windowTracker.connect('notify::focus-app', Lang.bind(this, this._updateActiveApp));
        Main.overview.connect('showing', Lang.bind(this, this._updateActiveApp));
        Main.overview.connect('hidden', Lang.bind(this, this._updateActiveApp));


        let keybindingSettings = new Gio.Settings({ schema: SHELL_KEYBINDINGS_SCHEMA });
        for (let index = 0; index < 8; index++) {
            let fullName = 'activate-icon-' + (index + 1);
            Main.wm.addKeybinding(fullName,
                                  keybindingSettings,
                                  Meta.KeyBindingFlags.NONE,
                                  Shell.ActionMode.NORMAL |
                                  Shell.ActionMode.OVERVIEW,
                                  this._activateNthApp.bind(this, index));
        }
        Main.wm.addKeybinding('activate-last-icon',
                              keybindingSettings,
                              Meta.KeyBindingFlags.NONE,
                              Shell.ActionMode.NORMAL |
                              Shell.ActionMode.OVERVIEW,
                              Lang.bind(this, this._activateLastApp));

        this._updateActiveApp();
    },

    _onAppIconPressed: function() {
        this._closeActivePanelMenu();
    },

    _closeActivePanelMenu: function() {
        let activeMenu = this._panel.menuManager.activeMenu;
        if (activeMenu)
            activeMenu.close(BoxPointer.PopupAnimation.FADE);
    },

    _activateNthApp: function(index) {
        this._scrolledIconList.activateNthApp(index);
    },

    _activateLastApp: function() {
        // Activate the index of the last button in the scrolled list
        this._activateNthApp(this._scrolledIconList.getNumAppButtons() - 1);
    },

    _updateActiveApp: function() {
        if (Main.overview.visible) {
            this._setActiveApp(null);
            return;
        }

        let focusApp = this._windowTracker.focus_app;
        this._setActiveApp(focusApp);
    },

    _setActiveApp: function(app) {
        this._scrolledIconList.setActiveApp(app);
    },

    _previousPageSelected: function() {
        this._scrolledIconList.pageBack();
    },

    _nextPageSelected: function() {
        this._scrolledIconList.pageForward();
    },

    _updateNavButtonState: function() {
        let backButtonOpacity = MAX_OPACITY;
        if (!this._scrolledIconList.isBackAllowed())
            backButtonOpacity = 0;

        let forwardButtonOpacity = MAX_OPACITY;
        if (!this._scrolledIconList.isForwardAllowed())
            forwardButtonOpacity = 0;

        this._backButton.opacity = backButtonOpacity;
        this._forwardButton.opacity = forwardButtonOpacity;
    },

    _getContentPreferredWidth: function(actor, forHeight, alloc) {
        let [minBackWidth, natBackWidth] = this._backButton.get_preferred_width(forHeight);
        let [minForwardWidth, natForwardWidth] = this._forwardButton.get_preferred_width(forHeight);

        // The scrolled icon list actor is a scrolled view with
        // hscrollbar-policy=NONE, so it will take the same width requisition as
        // its child. While we can use the natural one to measure the content,
        // we need a special method to measure the minimum width
        let minContentWidth = this._scrolledIconList.getMinContentWidth(forHeight);
        let [, natContentWidth] = this._scrolledIconList.actor.get_preferred_width(forHeight);

        alloc.min_size = minBackWidth + minForwardWidth + 2 * this._spacing + minContentWidth;
        alloc.natural_size = natBackWidth + natForwardWidth + 2 * this._spacing + natContentWidth;
    },

    _getContentPreferredHeight: function(actor, forWidth, alloc) {
        let [minListHeight, natListHeight] = this._scrolledIconList.actor.get_preferred_height(forWidth);
        let [minBackHeight, natBackHeight] = this._backButton.get_preferred_height(forWidth);
        let [minForwardHeight, natForwardHeight] = this._forwardButton.get_preferred_height(forWidth);

        let minButtonHeight = Math.max(minBackHeight, minForwardHeight);
        let natButtonHeight = Math.max(natBackHeight, natForwardHeight);

        alloc.min_size = Math.max(minButtonHeight, minListHeight);
        alloc.natural_size = Math.max(natButtonHeight, natListHeight);
    },

    _updateStyleConstants: function() {
        this._spacing = this._container.get_theme_node().get_length('spacing');
    },

    _contentAllocate: function(actor, box, flags) {
        let allocWidth = box.x2 - box.x1;
        let allocHeight = box.y2 - box.y1;

        let minBackWidth = this._backButton.get_preferred_width(allocHeight)[0];
        let minForwardWidth = this._forwardButton.get_preferred_width(allocHeight)[0];
        let maxIconSpace = Math.max(allocWidth - minBackWidth - minForwardWidth - 2 * this._spacing, 0);

        let childBox = new Clutter.ActorBox();
        childBox.y1 = 0;
        childBox.y2 = allocHeight;

        if (actor.get_text_direction() == Clutter.TextDirection.RTL) {
            childBox.x1 = allocWidth;
            childBox.x2 = allocWidth;

            if (this._scrolledIconList.isBackAllowed()) {
                childBox.x1 = childBox.x2 - minBackWidth;
                this._backButton.allocate(childBox, flags);

                childBox.x1 -= this._spacing;
            }

            childBox.x2 = childBox.x1;
            childBox.x1 = childBox.x2 - this._scrolledIconList.calculateNaturalSize(maxIconSpace) - 2 * this._spacing;
            this._scrolledIconList.actor.allocate(childBox, flags);

            childBox.x2 = childBox.x1;
            childBox.x1 = childBox.x2 - minForwardWidth;
            this._forwardButton.allocate(childBox, flags);
        } else {
            childBox.x1 = 0;
            childBox.x2 = 0;

            if (this._scrolledIconList.isBackAllowed()) {
                childBox.x2 = childBox.x1 + minBackWidth;
                this._backButton.allocate(childBox, flags);

                childBox.x2 += this._spacing;
            }

            childBox.x1 = childBox.x2;
            childBox.x2 = childBox.x1 + this._scrolledIconList.calculateNaturalSize(maxIconSpace) + 2 * this._spacing;
            this._scrolledIconList.actor.allocate(childBox, flags);

            childBox.x1 = childBox.x2;
            childBox.x2 = childBox.x1 + minForwardWidth;
            this._forwardButton.allocate(childBox, flags);
        }

        this._updateNavButtonState();
    }
});
