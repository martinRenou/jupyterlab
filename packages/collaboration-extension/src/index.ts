// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
/**
 * @packageDocumentation
 * @module collaboration-extension
 */

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';

import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';
import { DOMUtils } from '@jupyterlab/apputils';
import {
  AwarenessMock,
  CollaboratorsPanel,
  IAwareness,
  ICollaboratorLayout,
  ICurrentUser,
  IGlobalAwareness,
  IUserMenu,
  IUserPanel,
  IOpenDocs,
  RendererUserMenu,
  RTCPanel,
  User,
  UserInfoPanel,
  UserMenu
} from '@jupyterlab/collaboration';
import { usersIcon } from '@jupyterlab/ui-components';
import { AccordionPanel, Menu, MenuBar } from '@lumino/widgets';
import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { IStateDB, StateDB } from '@jupyterlab/statedb';
import { UUID } from '@lumino/coreutils';

/**
 * Jupyter plugin providing the ICurrentUser.
 */
const userPlugin: JupyterFrontEndPlugin<ICurrentUser> = {
  id: '@jupyterlab/collaboration-extension:user',
  autoStart: true,
  provides: ICurrentUser,
  activate: (app: JupyterFrontEnd): ICurrentUser => {
    return new User();
  }
};

/**
 * Jupyter plugin providing the IUserMenu.
 */
const userMenuPlugin: JupyterFrontEndPlugin<IUserMenu> = {
  id: '@jupyterlab/collaboration-extension:userMenu',
  autoStart: true,
  requires: [ICurrentUser],
  provides: IUserMenu,
  activate: (app: JupyterFrontEnd, user: ICurrentUser): IUserMenu => {
    const { commands } = app;
    return new UserMenu({ commands, user });
  }
};

/**
 * Jupyter plugin adding the IUserMenu to the menu bar if collaborative flag enabled.
 */
const menuBarPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/collaboration-extension:userMenuBar',
  autoStart: true,
  requires: [ICurrentUser, IUserMenu],
  activate: (
    app: JupyterFrontEnd,
    user: ICurrentUser,
    menu: IUserMenu
  ): void => {
    const { shell } = app;

    if (PageConfig.getOption('collaborative') !== 'true') {
      return;
    }

    const menuBar = new MenuBar({
      forceItemsPosition: {
        forceX: false,
        forceY: false
      },
      renderer: new RendererUserMenu(user)
    });
    menuBar.id = 'jp-UserMenu';
    user.changed.connect(() => menuBar.update());
    menuBar.addMenu(menu as Menu);
    shell.add(menuBar, 'top', { rank: 1000 });
  }
};

/**
 * Jupyter plugin creating a global awareness for RTC.
 */
const rtcGlobalAwarenessPlugin: JupyterFrontEndPlugin<IAwareness> = {
  id: '@jupyterlab/collaboration-extension:rtcGlobalAwareness',
  autoStart: true,
  requires: [ICurrentUser, IStateDB, ILabShell],
  provides: IGlobalAwareness,
  activate: (
    app: JupyterFrontEnd,
    currentUser: User,
    state: StateDB,
    shell: ILabShell
  ): IAwareness => {
    const ydoc = new Y.Doc();

    if (PageConfig.getOption('collaborative') !== 'true') {
      return new AwarenessMock(ydoc);
    }

    const awareness = new Awareness(ydoc);

    const server = ServerConnection.makeSettings();
    const url = URLExt.join(server.wsUrl, 'api/yjs');

    new WebsocketProvider(url, 'JupyterLab:globalAwareness', ydoc, {
      awareness: awareness
    });

    const userChanged = () => {
      const name =
        currentUser.displayName !== ''
          ? currentUser.displayName
          : currentUser.name;
      awareness.setLocalStateField('user', { ...currentUser.toJSON(), name });
    };
    if (currentUser.isReady) {
      userChanged();
    }
    currentUser.ready.connect(userChanged);
    currentUser.changed.connect(userChanged);

    state.changed.connect(async () => {
      const data: any = await state.toJSON();
      const current = data['layout-restorer:data']?.main?.current || '';

      // gets open widgets in the correct order
      const widgets = data['layout-restorer:data']?.main?.dock?.widgets || [];

      // get the extra data for each open widget (path, factory, etc)
      const openDocs: IOpenDocs = {}
      widgets.map((widget: string) => {
        if (data[widget]) {
          openDocs[widget] = data[widget]["data"];
        }
      });

      // set everything needed to sync the layout
      const layout: ICollaboratorLayout = {
        'current': current,
        'restorer': data['layout-restorer:data'],
        'dockPanelMode': shell.mode,
        'openDocs': openDocs,
        'uuid': UUID.uuid4().toString(),
      };
      awareness.setLocalStateField('layout', layout);
    });

    return awareness;
  }
};

/**
 * Jupyter plugin adding the RTC information to the application left panel if collaborative flag enabled.
 */
const rtcPanelPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/collaboration-extension:rtcPanel',
  autoStart: true,
  requires: [ICurrentUser, IGlobalAwareness, ILayoutRestorer, ILabShell],
  provides: IUserPanel,
  activate: (
    app: JupyterFrontEnd,
    currentUser: User,
    awareness: Awareness,
    restorer: ILayoutRestorer,
    shell: ILabShell
  ): void => {
    if (PageConfig.getOption('collaborative') !== 'true') {
      return;
    }

    const userPanel = new AccordionPanel({
      renderer: new RTCPanel.Renderer()
    });
    userPanel.id = DOMUtils.createDomID();
    userPanel.title.icon = usersIcon;
    userPanel.addClass('jp-RTCPanel');
    app.shell.add(userPanel, 'left', { rank: 300 });

    const currentUserPanel = new UserInfoPanel(currentUser);
    userPanel.addWidget(currentUserPanel);

    const fileopener = (path: string) => {
      app.commands.execute('docmanager:open', { path });
    };

    var lastLayoutUUID: string = '';

    const layoutRestorer = (collaboratorLayout: ICollaboratorLayout) => {

      // don't load the layout if it's the same as the last one
      if (lastLayoutUUID !== collaboratorLayout.uuid) {

        // open each document that the collaborator has open
        Object.entries(collaboratorLayout.openDocs).map(([key, value]) => {
          // value will be like {path: "Untitled.ipynb", factory: "Notebook"}
          app.commands.execute('docmanager:open', value);
        });

        const currentDoc = collaboratorLayout.openDocs[collaboratorLayout.current];
        if (currentDoc) {
          // open the current document that the collaborator is on
          app.commands.execute('docmanager:open', currentDoc);

          // restore the layout now that the same set of documents are open
          const layout = restorer.layoutFromJSON(collaboratorLayout.restorer);
          shell.restoreLayout(collaboratorLayout.dockPanelMode, layout);

          // set this so that we don't load the same layout again
          lastLayoutUUID = collaboratorLayout.uuid;
        }
      }
    }
    
    const collaboratorsPanel = new CollaboratorsPanel(
      currentUser,
      awareness,
      fileopener,
      layoutRestorer
    );
    userPanel.addWidget(collaboratorsPanel);
  }
};

/**
 * Export the plugins as default.
 */
const plugins: JupyterFrontEndPlugin<any>[] = [
  userPlugin,
  userMenuPlugin,
  menuBarPlugin,
  rtcGlobalAwarenessPlugin,
  rtcPanelPlugin
];

export default plugins;
