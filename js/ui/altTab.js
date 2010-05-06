/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */

const Clutter = imports.gi.Clutter;
const Gdk = imports.gi.Gdk;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Pango = imports.gi.Pango;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const Main = imports.ui.main;
const Tweener = imports.ui.tweener;

const POPUP_APPICON_SIZE = 96;
const POPUP_SCROLL_TIME = 0.10; // seconds

const DISABLE_HOVER_TIMEOUT = 500; // milliseconds

const THUMBNAIL_DEFAULT_SIZE = 256;
const THUMBNAIL_POPUP_TIME = 500; // milliseconds
const THUMBNAIL_FADE_TIME = 0.2; // seconds

const iconSizes = [96, 64, 48, 32, 22];

function mod(a, b) {
    return (a + b) % b;
}

function AltTabPopup() {
    this._init();
}

AltTabPopup.prototype = {
    _init : function() {
        this.actor = new Shell.GenericContainer({ name: 'altTabPopup',
                                                    reactive: true });

        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocate));

        this.actor.connect('destroy', Lang.bind(this, this._onDestroy));

        this._haveModal = false;

        this._currentApp = 0;
        this._currentWindow = 0;
        this._thumbnailTimeoutId = 0;
        this._motionTimeoutId = 0;

        // Initially disable hover so we ignore the enter-event if
        // the switcher appears underneath the current pointer location
        this._disableHover();

        global.stage.add_actor(this.actor);
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        alloc.min_size = global.screen_width;
        alloc.natural_size = global.screen_width;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        alloc.min_size = global.screen_height;
        alloc.natural_size = global.screen_height;
    },

    _allocate: function (actor, box, flags) {
        let childBox = new Clutter.ActorBox();
        let focus = global.get_focus_monitor();

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);
        let vPadding = this.actor.get_theme_node().get_vertical_padding();
        let hPadding = leftPadding + rightPadding;

        // Allocate the appSwitcher
        // We select a size based on an icon size that does not overflow the screen
        let [childMinHeight, childNaturalHeight] = this._appSwitcher.actor.get_preferred_height(focus.width - hPadding);
        let [childMinWidth, childNaturalWidth] = this._appSwitcher.actor.get_preferred_width(childNaturalHeight);
        childBox.x1 = Math.max(focus.x + leftPadding, focus.x + Math.floor((focus.width - childNaturalWidth) / 2));
        childBox.x2 = Math.min(childBox.x1 + focus.width - hPadding, childBox.x1 + childNaturalWidth);
        childBox.y1 = focus.y + Math.floor((focus.height - childNaturalHeight) / 2);
        childBox.y2 = childBox.y1 + childNaturalHeight;
        this._appSwitcher.actor.allocate(childBox, flags);

        // Allocate the thumbnails
        // We try to avoid overflowing the screen so we base the resulting size on
        // those calculations
        if (this._thumbnails) {
            let icon = this._appIcons[this._currentApp].actor;
            // Force a stage relayout to make sure we get the correct position
            global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, 0, 0);
            let [posX, posY] = icon.get_transformed_position();
            let thumbnailCenter = posX + icon.width / 2;
            let [childMinWidth, childNaturalWidth] = this._thumbnails.actor.get_preferred_width(-1);
            childBox.x1 = Math.max(focus.x + leftPadding, Math.floor(thumbnailCenter - childNaturalWidth / 2));
            if (childBox.x1 + childNaturalWidth > focus.x + focus.width - hPadding) {
                let offset = childBox.x1 + childNaturalWidth - focus.width + hPadding;
                childBox.x1 = Math.max(focus.x + leftPadding, childBox.x1 - offset - hPadding);
            }

            let [found, spacing] = this.actor.get_theme_node().get_length('spacing', false);
            if (!found)
                spacing = 0;

            childBox.x2 = childBox.x1 +  childNaturalWidth;
            if (childBox.x2 > focus.x + focus.width - rightPadding)
                childBox.x2 = focus.x + focus.width - rightPadding;
            childBox.y1 = this._appSwitcher.actor.allocation.y2 + spacing;
            this._thumbnails.addClones(focus.height - bottomPadding - childBox.y1);
            let [childMinHeight, childNaturalHeight] = this._thumbnails.actor.get_preferred_height(-1);
            childBox.y2 = childBox.y1 + childNaturalHeight;
            this._thumbnails.actor.allocate(childBox, flags);
        }
    },

    show : function(backward) {
        let tracker = Shell.WindowTracker.get_default();
        let apps = tracker.get_running_apps ("");

        if (!apps.length)
            return false;

        if (!Main.pushModal(this.actor))
            return false;
        this._haveModal = true;

        this._keyPressEventId = global.stage.connect('key-press-event', Lang.bind(this, this._keyPressEvent));
        this._keyReleaseEventId = global.stage.connect('key-release-event', Lang.bind(this, this._keyReleaseEvent));

        this.actor.connect('button-press-event', Lang.bind(this, this._clickedOutside));
        this.actor.connect('scroll-event', Lang.bind(this, this._onScroll));

        this._appSwitcher = new AppSwitcher(apps);
        this.actor.add_actor(this._appSwitcher.actor);
        this._appSwitcher.connect('item-activated', Lang.bind(this, this._appActivated));
        this._appSwitcher.connect('item-entered', Lang.bind(this, this._appEntered));

        this._appIcons = this._appSwitcher.icons;

        // Make the initial selection
        if (this._appIcons.length == 1) {
            if (!backward && this._appIcons[0].cachedWindows.length > 1) {
                // For compatibility with the multi-app case below
                this._select(0, 1, true);
            } else
                this._select(0);
        } else if (backward) {
            this._select(this._appIcons.length - 1);
        } else {
            let firstWindows = this._appIcons[0].cachedWindows;
            if (firstWindows.length > 1) {
                let curAppNextWindow = firstWindows[1];
                let nextAppWindow = this._appIcons[1].cachedWindows[0];

                // If the next window of the current app is more-recently-used
                // than the first window of the next app, then select it.
                if (curAppNextWindow.get_workspace() == global.screen.get_active_workspace() &&
                    curAppNextWindow.get_user_time() > nextAppWindow.get_user_time())
                    this._select(0, 1, true);
                else
                    this._select(1);
            } else
                this._select(1);
        }

        // There's a race condition; if the user released Alt before
        // we got the grab, then we won't be notified. (See
        // https://bugzilla.gnome.org/show_bug.cgi?id=596695 for
        // details.) So we check now. (Have to do this after updating
        // selection.)
        let [x, y, mods] = global.get_pointer();
        if (!(mods & Gdk.ModifierType.MOD1_MASK)) {
            this._finish();
            return false;
        }

        return true;
    },

    _nextApp : function() {
        return mod(this._currentApp + 1, this._appIcons.length);
    },
    _previousApp : function() {
        return mod(this._currentApp - 1, this._appIcons.length);
    },

    _nextWindow : function() {
        return mod(this._currentWindow + 1,
                   this._appIcons[this._currentApp].cachedWindows.length);
    },
    _previousWindow : function() {
        return mod(this._currentWindow - 1,
                   this._appIcons[this._currentApp].cachedWindows.length);
    },

    _keyPressEvent : function(actor, event) {
        let keysym = event.get_key_symbol();
        let shift = (Shell.get_event_state(event) & Clutter.ModifierType.SHIFT_MASK);

        this._disableHover();

        // The WASD stuff is for debugging in Xephyr, where the arrow
        // keys aren't mapped correctly

        if (keysym == Clutter.grave)
            this._select(this._currentApp, shift ? this._previousWindow() : this._nextWindow());
        else if (keysym == Clutter.Escape)
            this.destroy();
        else if (this._thumbnailsFocused) {
            if (keysym == Clutter.Tab) {
                if (shift && this._currentWindow == 0)
                    this._select(this._previousApp());
                else if (!shift && this._currentWindow == this._appIcons[this._currentApp].cachedWindows.length - 1)
                    this._select(this._nextApp());
                else
                    this._select(this._currentApp, shift ? this._previousWindow() : this._nextWindow());
            } else if (keysym == Clutter.Left || keysym == Clutter.a)
                this._select(this._currentApp, this._previousWindow());
            else if (keysym == Clutter.Right || keysym == Clutter.d)
                this._select(this._currentApp, this._nextWindow());
            else if (keysym == Clutter.Up || keysym == Clutter.w)
                this._select(this._currentApp, null, true);
        } else {
            if (keysym == Clutter.Tab)
                this._select(shift ? this._previousApp() : this._nextApp());
            else if (keysym == Clutter.Left || keysym == Clutter.a)
                this._select(this._previousApp());
            else if (keysym == Clutter.Right || keysym == Clutter.d)
                this._select(this._nextApp());
            else if (keysym == Clutter.Down || keysym == Clutter.s)
                this._select(this._currentApp, this._currentWindow);
        }

        return true;
    },

    _keyReleaseEvent : function(actor, event) {
        let keysym = event.get_key_symbol();

        if (keysym == Clutter.Alt_L || keysym == Clutter.Alt_R)
            this._finish();

        return true;
    },

    _onScroll : function(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP) {
            if (this._thumbnailsFocused) {
                if (this._currentWindow == 0)
                    this._select(this._previousApp());
                else
                    this._select(this._currentApp, this._previousWindow());
            } else {
                let nwindows = this._appIcons[this._currentApp].cachedWindows.length;
                if (nwindows > 1)
                    this._select(this._currentApp, nwindows - 1);
                else
                    this._select(this._previousApp());
            }
        } else if (direction == Clutter.ScrollDirection.DOWN) {
            if (this._thumbnailsFocused) {
                if (this._currentWindow == this._appIcons[this._currentApp].cachedWindows.length - 1)
                    this._select(this._nextApp());
                else
                    this._select(this._currentApp, this._nextWindow());
            } else {
                let nwindows = this._appIcons[this._currentApp].cachedWindows.length;
                if (nwindows > 1)
                    this._select(this._currentApp, 0);
                else
                    this._select(this._nextApp());
            }
        }
    },

    _clickedOutside : function(actor, event) {
        this.destroy();
    },

    _appActivated : function(appSwitcher, n) {
        // If the user clicks on the selected app, activate the
        // selected window; otherwise (eg, they click on an app while
        // !mouseActive) activate the first window of the clicked-on
        // app.
        let appIcon = this._appIcons[n];
        let windowIndex = (n == this._currentApp) ? this._currentWindow : 0;
        let window = appIcon.cachedWindows[windowIndex];
        appIcon.app.activate_window(window, global.get_current_time());
        this.destroy();
    },

    _appEntered : function(appSwitcher, n) {
        if (!this._mouseActive)
            return;

        this._select(n);
    },

    _windowActivated : function(thumbnailList, n) {
        let appIcon = this._appIcons[this._currentApp];
        appIcon.app.activate_window(appIcon.cachedWindows[n]);
        this.destroy();
    },

    _windowEntered : function(thumbnailList, n) {
        if (!this._mouseActive)
            return;

        this._select(this._currentApp, n);
    },

    _disableHover : function() {
        this._mouseActive = false;

        if (this._motionTimeoutId != 0)
            Mainloop.source_remove(this._motionTimeoutId);

        this._motionTimeoutId = Mainloop.timeout_add(DISABLE_HOVER_TIMEOUT, Lang.bind(this, this._mouseTimedOut));
    },

    _mouseTimedOut : function() {
        this._motionTimeoutId = 0;
        this._mouseActive = true;
    },

    _finish : function() {
        let appIcon = this._appIcons[this._currentApp];
        let window = appIcon.cachedWindows[this._currentWindow];
        appIcon.app.activate_window(window, global.get_current_time());
        this.destroy();
    },

    destroy : function() {
        this.actor.destroy();
    },

    _onDestroy : function() {
        if (this._haveModal)
            Main.popModal(this.actor);

        if (this._thumbnails)
            this._destroyThumbnails();

        if (this._keyPressEventId)
            global.stage.disconnect(this._keyPressEventId);
        if (this._keyReleaseEventId)
            global.stage.disconnect(this._keyReleaseEventId);

        if (this._motionTimeoutId != 0)
            Mainloop.source_remove(this._motionTimeoutId);
        if (this._thumbnailTimeoutId != 0)
            Mainloop.source_remove(this._thumbnailTimeoutId);
    },

    /**
     * _select:
     * @app: index of the app to select
     * @window: (optional) index of which of @app's windows to select
     * @forceAppFocus: optional flag, see below
     *
     * Selects the indicated @app, and optional @window, and sets
     * this._thumbnailsFocused appropriately to indicate whether the
     * arrow keys should act on the app list or the thumbnail list.
     *
     * If @app is specified and @window is unspecified or %null, then
     * the app is highlighted (ie, given a light background), and the
     * current thumbnail list, if any, is destroyed. If @app has
     * multiple windows, and @forceAppFocus is not %true, then a
     * timeout is started to open a thumbnail list.
     *
     * If @app and @window are specified (and @forceAppFocus is not),
     * then @app will be outlined, a thumbnail list will be created
     * and focused (if it hasn't been already), and the @window'th
     * window in it will be highlighted.
     *
     * If @app and @window are specified and @forceAppFocus is %true,
     * then @app will be highlighted, and @window outlined, and the
     * app list will have the keyboard focus.
     */
    _select : function(app, window, forceAppFocus) {
        if (app != this._currentApp || window == null) {
            if (this._thumbnails)
                this._destroyThumbnails();
        }

        if (this._thumbnailTimeoutId != 0) {
            Mainloop.source_remove(this._thumbnailTimeoutId);
            this._thumbnailTimeoutId = 0;
        }

        this._thumbnailsFocused = (window != null) && !forceAppFocus;

        this._currentApp = app;
        this._currentWindow = window ? window : 0;
        this._appSwitcher.highlight(app, this._thumbnailsFocused);

        if (window != null) {
            if (!this._thumbnails)
                this._createThumbnails();
            this._currentWindow = window;
            this._thumbnails.highlight(window, forceAppFocus);
        } else if (this._appIcons[this._currentApp].cachedWindows.length > 1 &&
                   !forceAppFocus) {
            this._thumbnailTimeoutId = Mainloop.timeout_add (
                THUMBNAIL_POPUP_TIME,
                Lang.bind(this, function () {
                              this._select(this._currentApp, 0, true);
                              return false;
                          }));
        }
    },

    _destroyThumbnails : function() {
        Tweener.addTween(this._thumbnails.actor,
                         { opacity: 0,
                           time: THUMBNAIL_FADE_TIME,
                           transition: "easeOutQuad",
                           onComplete: function() { this.destroy(); }
                         });
        this._thumbnails = null;
    },

    _createThumbnails : function() {
        this._thumbnails = new ThumbnailList (this._appIcons[this._currentApp].cachedWindows);
        this._thumbnails.connect('item-activated', Lang.bind(this, this._windowActivated));
        this._thumbnails.connect('item-entered', Lang.bind(this, this._windowEntered));

        this.actor.add_actor(this._thumbnails.actor);

        this._thumbnails.actor.opacity = 0;
        Tweener.addTween(this._thumbnails.actor,
                         { opacity: 255,
                           time: THUMBNAIL_FADE_TIME,
                           transition: "easeOutQuad"
                         });
    }
};

function SwitcherList(squareItems) {
    this._init(squareItems);
}

SwitcherList.prototype = {
    _init : function(squareItems) {
        this.actor = new Shell.GenericContainer({ style_class: 'switcher-list' });
        this.actor.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this.actor.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this.actor.connect('allocate', Lang.bind(this, this._allocateTop));

        // Here we use a GenericContainer so that we can force all the
        // children except the separator to have the same width.
        this._list = new Shell.GenericContainer({ style_class: 'switcher-list-item-container' });
        this._list.spacing = 0;
        this._list.connect('style-changed', Lang.bind(this, function() {
                                                        let [found, spacing] = this._list.get_theme_node().get_length('spacing', false);
                                                        this._list.spacing = (found) ? spacing : 0;
                                                     }));

        this._list.connect('get-preferred-width', Lang.bind(this, this._getPreferredWidth));
        this._list.connect('get-preferred-height', Lang.bind(this, this._getPreferredHeight));
        this._list.connect('allocate', Lang.bind(this, this._allocate));

        this._clipBin = new St.Bin({style_class: 'cbin'});
        this._clipBin.child = this._list;
        this.actor.add_actor(this._clipBin);

        this._leftGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-left', vertical: true});
        this._rightGradient = new St.BoxLayout({style_class: 'thumbnail-scroll-gradient-right', vertical: true});
        this.actor.add_actor(this._leftGradient);
        this.actor.add_actor(this._rightGradient);

        // Those arrows indicate whether scrolling in one direction is possible
        this._leftArrow = new St.DrawingArea({ style_class: 'switcher-arrow',
                                               pseudo_class: 'highlighted' });
        this._leftArrow.connect('repaint', Lang.bind(this,
                                            function (area) {
                                                Shell.draw_box_pointer(area, Shell.PointerDirection.LEFT);
                                            }));

        this._rightArrow = new St.DrawingArea({ style_class: 'switcher-arrow',
                                                pseudo_class: 'highlighted' });
        this._rightArrow.connect('repaint', Lang.bind(this,
                                            function (area) {
                                                Shell.draw_box_pointer(area, Shell.PointerDirection.RIGHT);
                                            }));

        this.actor.add_actor(this._leftArrow);
        this.actor.add_actor(this._rightArrow);

        this._items = [];
        this._highlighted = -1;
        this._separator = null;
        this._squareItems = squareItems;
        this._minSize = 0;
        this._scrollableRight = true;
        this._scrollableLeft = false;
    },

    _allocateTop: function(actor, box, flags) {
        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);

        let childBox = new Clutter.ActorBox();
        let scrollable = this._minSize > box.x2 - box.x1;

        this._clipBin.allocate(box, flags);

        childBox.x1 = 0;
        childBox.y1 = 0;
        childBox.x2 = this._leftGradient.width;
        childBox.y2 = this.actor.height;
        this._leftGradient.allocate(childBox, flags);
        this._leftGradient.opacity = (this._scrollableLeft && scrollable) ? 255 : 0;

        childBox.x1 = (this.actor.allocation.x2 - this.actor.allocation.x1) - this._rightGradient.width;
        childBox.y1 = 0;
        childBox.x2 = childBox.x1 + this._rightGradient.width;
        childBox.y2 = this.actor.height;
        this._rightGradient.allocate(childBox, flags);
        this._rightGradient.opacity = (this._scrollableRight && scrollable) ? 255 : 0;

        let arrowWidth = Math.floor(leftPadding / 3);
        let arrowHeight = arrowWidth * 2;
        childBox.x1 = leftPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._leftArrow.allocate(childBox, flags);
        this._leftArrow.opacity = this._leftGradient.opacity;

        arrowWidth = Math.floor(rightPadding / 3);
        arrowHeight = arrowWidth * 2;
        childBox.x1 = this.actor.width - arrowWidth - rightPadding / 2;
        childBox.y1 = this.actor.height / 2 - arrowWidth;
        childBox.x2 = childBox.x1 + arrowWidth;
        childBox.y2 = childBox.y1 + arrowHeight;
        this._rightArrow.allocate(childBox, flags);
        this._rightArrow.opacity = this._rightGradient.opacity;
    },

    addItem : function(item) {
        let bbox = new St.Clickable({ style_class: 'item-box',
                                      reactive: true });

        bbox.set_child(item);
        this._list.add_actor(bbox);

        let n = this._items.length;
        bbox.connect('clicked', Lang.bind(this, function () {
                                               this._itemActivated(n);
                                          }));
        bbox.connect('enter-event', Lang.bind(this, function () {
                                                  this._itemEntered(n);
                                              }));

        this._items.push(bbox);
    },

    addSeparator: function () {
        let box = new St.Bin({ style_class: 'separator' });
        this._separator = box;
        this._list.add_actor(box);
    },

    highlight: function(index, justOutline) {
        if (this._highlighted != -1)
            this._items[this._highlighted].style_class = 'item-box';

        this._highlighted = index;

        if (this._highlighted != -1) {
            if (justOutline)
                this._items[this._highlighted].style_class = 'outlined-item-box';
            else
                this._items[this._highlighted].style_class = 'selected-item-box';
        }

        let monitor = global.get_focus_monitor();
        let itemSize = this._items[index].allocation.x2 - this._items[index].allocation.x1;
        let [posX, posY] = this._items[index].get_transformed_position();
        posX += this.actor.x;
        if (posX + itemSize > monitor.width + monitor.x)
            this._scrollToRight();
        else if (posX < 0)
            this._scrollToLeft();

    },

    _scrollToLeft : function() {
        let x = this._items[this._highlighted].allocation.x1;
        this._scrollableRight = true;
        Tweener.addTween(this._list, { anchor_x: x,
                                        time: POPUP_SCROLL_TIME,
                                        transition: 'easeOutQuad',
                                        onComplete: Lang.bind(this, function () {
                                                                        if (this._highlighted == 0) {
                                                                            this._scrollableLeft = false;
                                                                            this.actor.queue_relayout();
                                                                        }
                                                             })
                        });
    },

    _scrollToRight : function() {
        this._scrollableLeft = true;
        let monitor = global.get_focus_monitor();
        let padding = this.actor.get_theme_node().get_horizontal_padding();
        let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
        let x = this._items[this._highlighted].allocation.x2 - monitor.width + padding + parentPadding;
        Tweener.addTween(this._list, { anchor_x: x,
                                        time: POPUP_SCROLL_TIME,
                                        transition: 'easeOutQuad',
                                        onComplete: Lang.bind(this, function () {
                                                                        if (this._highlighted == this._items.length - 1) {
                                                                            this._scrollableRight = false;
                                                                            this.actor.queue_relayout();
                                                                        }
                                                             })
                        });
    },

    _itemActivated: function(n) {
        this.emit('item-activated', n);
    },

    _itemEntered: function(n) {
        this.emit('item-entered', n);
    },

    _maxChildWidth: function (forHeight) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_width(forHeight);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);

            if (this._squareItems) {
                let [childMin, childNat] = this._items[i].get_preferred_height(-1);
                maxChildMin = Math.max(childMin, maxChildMin);
                maxChildNat = Math.max(childNat, maxChildNat);
            }
        }

        return [maxChildMin, maxChildNat];
    },

    _getPreferredWidth: function (actor, forHeight, alloc) {
        let [maxChildMin, maxChildNat] = this._maxChildWidth(forHeight);

        let separatorWidth = 0;
        if (this._separator) {
            let [sepMin, sepNat] = this._separator.get_preferred_width(forHeight);
            separatorWidth = sepNat + this._list.spacing;
        }

        let totalSpacing = this._list.spacing * (this._items.length - 1);
        alloc.min_size = this._items.length * maxChildMin + separatorWidth + totalSpacing;
        alloc.natural_size = alloc.min_size;
        this._minSize = alloc.min_size;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let maxChildMin = 0;
        let maxChildNat = 0;

        for (let i = 0; i < this._items.length; i++) {
            let [childMin, childNat] = this._items[i].get_preferred_height(-1);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = Math.max(childNat, maxChildNat);
        }

        if (this._squareItems) {
            let [childMin, childNat] = this._maxChildWidth(-1);
            maxChildMin = Math.max(childMin, maxChildMin);
            maxChildNat = maxChildMin;
        }

        alloc.min_size = maxChildMin;
        alloc.natural_size = maxChildNat;
    },

    _allocate: function (actor, box, flags) {
        let childHeight = box.y2 - box.y1;

        let [maxChildMin, maxChildNat] = this._maxChildWidth(childHeight);
        let totalSpacing = this._list.spacing * (this._items.length - 1);

        let separatorWidth = 0;
        if (this._separator) {
            let [sepMin, sepNat] = this._separator.get_preferred_width(childHeight);
            separatorWidth = sepNat;
            totalSpacing += this._list.spacing;
        }

        let childWidth = Math.floor(Math.max(0, box.x2 - box.x1 - totalSpacing - separatorWidth) / this._items.length);

        let x = 0;
        let children = this._list.get_children();
        let childBox = new Clutter.ActorBox();

        let focus = global.get_focus_monitor();
        let parentRightPadding = this.actor.get_parent().get_theme_node().get_padding(St.Side.RIGHT);
        if (this.actor.allocation.x2 == focus.x + focus.width - parentRightPadding) {
            if (this._squareItems)
                childWidth = childHeight;
            else {
                let [childMin, childNat] = children[0].get_preferred_width(childHeight);
                childWidth = childMin;
            }
        }

        for (let i = 0; i < children.length; i++) {
            if (this._items.indexOf(children[i]) != -1) {
                let [childMin, childNat] = children[i].get_preferred_height(childWidth);
                let vSpacing = (childHeight - childNat) / 2;
                childBox.x1 = x;
                childBox.y1 = vSpacing;
                childBox.x2 = x + childWidth;
                childBox.y2 = childBox.y1 + childNat;
                children[i].allocate(childBox, flags);

                x += this._list.spacing + childWidth;
            } else if (children[i] == this._separator) {
                // We want the separator to be more compact than the rest.
                childBox.x1 = x;
                childBox.y1 = 0;
                childBox.x2 = x + separatorWidth;
                childBox.y2 = childHeight;
                children[i].allocate(childBox, flags);
                x += this._list.spacing + separatorWidth;
            } else {
                // Something else, eg, AppSwitcher's arrows;
                // we don't allocate it.
            }
        }

        let leftPadding = this.actor.get_theme_node().get_padding(St.Side.LEFT);
        let rightPadding = this.actor.get_theme_node().get_padding(St.Side.RIGHT);
        let topPadding = this.actor.get_theme_node().get_padding(St.Side.TOP);
        let bottomPadding = this.actor.get_theme_node().get_padding(St.Side.BOTTOM);

        // Clip the area for scrolling
        this._clipBin.set_clip(0, -topPadding, (this.actor.allocation.x2 - this.actor.allocation.x1) - leftPadding - rightPadding, this.actor.height + bottomPadding);
    }
};

Signals.addSignalMethods(SwitcherList.prototype);

function AppIcon(app) {
    this._init(app);
}

AppIcon.prototype = {
    _init: function(app) {
        this.app = app;
        this.actor = new St.BoxLayout({ style_class: "alt-tab-app",
                                         vertical: true });
        this.icon = null;
        this._iconBin = new St.Bin();

        this.actor.add(this._iconBin, { x_fill: false, y_fill: false } );
        this.label = new St.Label({ text: this.app.get_name() });
        this.actor.add(this.label, { x_fill: false });
    },

    set_size: function(size) {
        this.icon = this.app.create_icon_texture(size);
        this._iconBin.set_size(size, size);
        this._iconBin.child = this.icon;
    }
};

function AppSwitcher(apps) {
    this._init(apps);
}

AppSwitcher.prototype = {
    __proto__ : SwitcherList.prototype,

    _init : function(apps) {
        SwitcherList.prototype._init.call(this, true);

        // Construct the AppIcons, sort by time, add to the popup
        let activeWorkspace = global.screen.get_active_workspace();
        let workspaceIcons = [];
        let otherIcons = [];
        for (let i = 0; i < apps.length; i++) {
            let appIcon = new AppIcon(apps[i]);
            // Cache the window list now; we don't handle dynamic changes here,
            // and we don't want to be continually retrieving it
            appIcon.cachedWindows = appIcon.app.get_windows();
            if (this._hasWindowsOnWorkspace(appIcon, activeWorkspace))
              workspaceIcons.push(appIcon);
            else
              otherIcons.push(appIcon);
        }

        workspaceIcons.sort(Lang.bind(this, this._sortAppIcon));
        otherIcons.sort(Lang.bind(this, this._sortAppIcon));

        this.icons = [];
        this._arrows = [];
        for (let i = 0; i < workspaceIcons.length; i++)
            this._addIcon(workspaceIcons[i]);
        if (workspaceIcons.length > 0 && otherIcons.length > 0)
            this.addSeparator();
        for (let i = 0; i < otherIcons.length; i++)
            this._addIcon(otherIcons[i]);

        this._curApp = -1;
        this._iconSize = 0;
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let j = 0;
        while(this._items.length > 1 && this._items[j].style_class != 'item-box') {
                j++;
        }
        let iconPadding = this._items[j].get_theme_node().get_horizontal_padding();
        let [iconMinHeight, iconNaturalHeight] = this.icons[j].label.get_preferred_height(-1);
        let iconSpacing = iconNaturalHeight + iconPadding;
        let totalSpacing = this._list.spacing * (this._items.length - 1);
        if (this._separator)
           totalSpacing += this._separator.width + this._list.spacing;

        // We just assume the whole screen here due to weirdness happing with the passed width
        let focus = global.get_focus_monitor();
        let parentPadding = this.actor.get_parent().get_theme_node().get_horizontal_padding();
        let availWidth = focus.width - parentPadding - this.actor.get_theme_node().get_horizontal_padding();
        let height = 0;

        for(let i =  0; i < iconSizes.length; i++) {
                this._iconSize = iconSizes[i];
                height = iconSizes[i] + iconSpacing;
                let w = height * this._items.length + totalSpacing;
                if (w <= availWidth)
                        break;
        }

        if (this._items.length == 1) {
            this._iconSize = iconSizes[0];
            height = iconSizes[0] + iconSpacing;
        }

        for(let i = 0; i < this.icons.length; i++) {
            if (this.icons[i].icon != null)
                break;
            this.icons[i].set_size(this._iconSize);
        }

        alloc.min_size = height;
        alloc.natural_size = height;
    },

    _allocate: function (actor, box, flags) {
        // Allocate the main list items
        SwitcherList.prototype._allocate.call(this, actor, box, flags);

        let arrowHeight = Math.floor(this.actor.get_theme_node().get_padding(St.Side.BOTTOM) / 3);
        let arrowWidth = arrowHeight * 2;

        // Now allocate each arrow underneath its item
        let childBox = new Clutter.ActorBox();
        for (let i = 0; i < this._items.length; i++) {
            let itemBox = this._items[i].allocation;
            childBox.x1 = Math.floor(itemBox.x1 + (itemBox.x2 - itemBox.x1 - arrowWidth) / 2);
            childBox.x2 = childBox.x1 + arrowWidth;
            childBox.y1 = itemBox.y2 + arrowHeight;
            childBox.y2 = childBox.y1 + arrowHeight;
            this._arrows[i].allocate(childBox, flags);
        }
    },

    // We override SwitcherList's highlight() method to also deal with
    // the AppSwitcher->ThumbnailList arrows. Apps with only 1 window
    // will hide their arrows by default, but show them when their
    // thumbnails are visible (ie, when the app icon is supposed to be
    // in justOutline mode). Apps with multiple windows will normally
    // show a dim arrow, but show a bright arrow when they are
    // highlighted.
    highlight : function(n, justOutline) {
        if (this._curApp != -1) {
            if (this.icons[this._curApp].cachedWindows.length == 1)
                this._arrows[this._curApp].hide();
            else
                this._arrows[this._curApp].remove_style_pseudo_class('highlighted');
        }

        SwitcherList.prototype.highlight.call(this, n, justOutline);
        this._curApp = n;

        if (this._curApp != -1) {
            if (justOutline && this.icons[this._curApp].cachedWindows.length == 1)
                this._arrows[this._curApp].show();
            else
                this._arrows[this._curApp].add_style_pseudo_class('highlighted');
        }
    },

    _addIcon : function(appIcon) {
        this.icons.push(appIcon);
        this.addItem(appIcon.actor);

        let n = this._arrows.length;
        let arrow = new St.DrawingArea({ style_class: 'switcher-arrow' });
        arrow.connect('repaint', Lang.bind(this,
            function (area) {
                Shell.draw_box_pointer(area, Shell.PointerDirection.DOWN);
            }));
        this._list.add_actor(arrow);
        this._arrows.push(arrow);

        if (appIcon.cachedWindows.length == 1)
            arrow.hide();
    },

    _hasWindowsOnWorkspace: function(appIcon, workspace) {
        let windows = appIcon.cachedWindows;
        for (let i = 0; i < windows.length; i++) {
            if (windows[i].get_workspace() == workspace)
                return true;
        }
        return false;
    },

    _sortAppIcon : function(appIcon1, appIcon2) {
        return appIcon1.app.compare(appIcon2.app);
    }
};

function ThumbnailList(windows) {
    this._init(windows);
}

ThumbnailList.prototype = {
    __proto__ : SwitcherList.prototype,

    _init : function(windows) {
        SwitcherList.prototype._init.call(this);

        let activeWorkspace = global.screen.get_active_workspace();

        // We fake the value of "separatorAdded" when the app has no window
        // on the current workspace, to avoid displaying a useless separator in
        // that case.
        let separatorAdded = windows.length == 0 || windows[0].get_workspace() != activeWorkspace;

        this._labels = new Array();
        this._thumbnailBins = new Array();
        this._clones = new Array();
        this._windows = windows;

        for (let i = 0; i < windows.length; i++) {
            if (!separatorAdded && windows[i].get_workspace() != activeWorkspace) {
              this.addSeparator();
              separatorAdded = true;
            }

            let box = new St.BoxLayout({ style_class: "thumbnail-box",
                                         vertical: true });

            let bin = new St.Bin({ style_class: "thumbnail" });

            box.add_actor(bin);
            this._thumbnailBins.push(bin);

            let title = windows[i].get_title();
            if (title) {
                let name = new St.Label({ text: title });
                // St.Label doesn't support text-align so use a Bin
                let bin = new St.Bin({ x_align: St.Align.MIDDLE });
                this._labels.push(bin);
                bin.add_actor(name);
                box.add_actor(bin);
            }

            this.addItem(box);
        }
    },

    addClones : function (availHeight) {
        if (!this._thumbnailBins.length)
            return;
        let totalPadding = this._items[0].get_theme_node().get_horizontal_padding() + this._items[0].get_theme_node().get_vertical_padding();
        totalPadding += this.actor.get_theme_node().get_horizontal_padding() + this.actor.get_theme_node().get_vertical_padding();
        let [labelMinHeight, labelNaturalHeight] = this._labels[0].get_preferred_height(-1);
        let [found, spacing] = this._items[0].child.get_theme_node().get_length('spacing', false);
        if (!found)
            spacing = 0;

        availHeight = Math.min(availHeight - labelNaturalHeight - totalPadding - spacing, THUMBNAIL_DEFAULT_SIZE);
        let binHeight = availHeight + this._items[0].get_theme_node().get_vertical_padding() + this.actor.get_theme_node().get_vertical_padding() - spacing;
        binHeight = Math.min(THUMBNAIL_DEFAULT_SIZE, binHeight);

        for (let i = 0; i < this._thumbnailBins.length; i++) {
            let mutterWindow = this._windows[i].get_compositor_private();
            let windowTexture = mutterWindow.get_texture ();
            let [width, height] = windowTexture.get_size();
            let scale = Math.min(1.0, THUMBNAIL_DEFAULT_SIZE / width, availHeight / height);
            let clone = new Clutter.Clone ({ source: windowTexture,
                                                reactive: true,
                                                width: width * scale,
                                                height: height * scale });

            this._thumbnailBins[i].set_height(binHeight);
            this._thumbnailBins[i].add_actor(clone);
            this._clones.push(clone);
        }

        // Make sure we only do this once
        this._thumbnailBins = new Array();
    }
};
