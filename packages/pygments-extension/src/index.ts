import {
    JupyterFrontEnd,
    JupyterFrontEndPlugin
} from '@jupyterlab/application';

/**
 * Initialization data for the pygments extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
    id: '@jupyterlab/pygments-extension:plugin',
    autoStart: true,
    activate: (app: JupyterFrontEnd) => {
        console.log('@jupyterlab/pygments-extension is activated!');
    }
};

export default plugin;
