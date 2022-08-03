// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import * as React from 'react';

import { Awareness } from 'y-protocols/awareness';

import { Panel } from '@lumino/widgets';

import { ReactWidget } from '@jupyterlab/apputils';

import { ICurrentUser } from './tokens';
import { ICollaboratorAwareness, ICollaboratorLayout } from './utils';
import { PathExt } from '@jupyterlab/coreutils';

/**
 * The CSS class added to collaborators list container.
 */
const COLLABORATORS_LIST_CLASS = 'jp-CollaboratorsList';

/**
 * The CSS class added to each collaborator element.
 */
const COLLABORATOR_CLASS = 'jp-Collaborator';

/**
 * The CSS class added to each collaborator element.
 */
const CLICKABLE_COLLABORATOR_CLASS = 'jp-ClickableCollaborator';

/**
 * The CSS class added to each collaborator icon.
 */
const COLLABORATOR_ICON_CLASS = 'jp-CollaboratorIcon';

export class CollaboratorsPanel extends Panel {
  private _currentUser: ICurrentUser;
  private _awareness: Awareness;
  private _body: CollaboratorsBody;
  private _layoutRestorer: (layout: ICollaboratorLayout) => void;

  constructor(
    currentUser: ICurrentUser,
    awareness: Awareness,
    fileopener: (path: string) => void,
    layoutRestorer: (layout: ICollaboratorLayout) => void
  ) {
    super({});

    this._awareness = awareness;

    this._currentUser = currentUser;
    this._layoutRestorer = layoutRestorer;

    this._body = new CollaboratorsBody(fileopener);
    this.addWidget(this._body);
    this.update();

    this._awareness.on('change', this._onAwarenessChanged);
  }

  /**
   * Handle collaborator change.
   */
  private _onAwarenessChanged = () => {
    const state = this._awareness.getStates();
    const collaborators: ICollaboratorAwareness[] = [];

    state.forEach((value: ICollaboratorAwareness, key: any) => {
      if (value.user.name !== this._currentUser.name) {
        collaborators.push(value);
      }

      if (value.layout) {
        if (value.user.name === this._body.followingUser && this._currentUser.name !== this._body.followingUser) {
          this._layoutRestorer(value.layout);
        }
      }
    });

    this._body.collaborators = collaborators;
  };
}

/**
 * The collaborators list.
 */
export class CollaboratorsBody extends ReactWidget {
  private _collaborators: ICollaboratorAwareness[] = [];
  private _fileopener: (path: string) => void;
  private _followingUser: string;

  constructor(fileopener: (path: string) => void) {
    super();
    this._fileopener = fileopener;
    this._followingUser = '';
    this.addClass(COLLABORATORS_LIST_CLASS);
  }

  get collaborators(): ICollaboratorAwareness[] {
    return this._collaborators;
  }

  set collaborators(value: ICollaboratorAwareness[]) {
    this._collaborators = value;
    this.update();
  }

  get followingUser(): string {
    return this._followingUser;
  }

  set followingUser(user: string) {
    this._followingUser = user;
    this.update();
  }

  render(): React.ReactElement<any>[] {
    return this._collaborators.map((value, i) => {
      let canOpenCurrent = false;
      let current = '';
      let separator = '';
      let currentFileLocation = '';
      
      if (value.layout && value.layout.current) {
        canOpenCurrent = true;
        currentFileLocation = value.layout.current.split(':')[1];

        current = PathExt.basename(currentFileLocation);
        current =
          current.length > 25 ? current.slice(0, 12).concat(`…`) : current;
        separator = '•';
      }

      const onClick = () => {
        if (canOpenCurrent) {
          this._fileopener(currentFileLocation);
        }
      };

      const onFollowClick = () => {
        this.followingUser = value.user.name;
      }

      const onUnfollowClick = () => {
        this.followingUser = "";
      }

      const displayName = `${
        value.user.displayName != '' ? value.user.displayName : value.user.name
      } ${separator} ${current}`;

      const isFollowing = value.user.name === this._followingUser;

      return (
        <div
          className={
            canOpenCurrent
              ? `${CLICKABLE_COLLABORATOR_CLASS} ${COLLABORATOR_CLASS}`
              : COLLABORATOR_CLASS
          }
          key={i}
        >
          <div
            className={COLLABORATOR_ICON_CLASS}
            style={{ backgroundColor: value.user.color }}
            onClick={onClick}
          >
            <span>{value.user.initials}</span>
          </div>
          <span>{displayName}</span>
          &nbsp;&nbsp;|&nbsp;&nbsp;
          {isFollowing ? <div onClick={onUnfollowClick}>Unfollow</div> : <div onClick={onFollowClick}>Follow</div>}
        </div>
      );
    });
  }
}
