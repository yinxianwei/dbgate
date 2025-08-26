const crypto = require('crypto');
const connections = require('./connections');
const socket = require('../utility/socket');
const { fork } = require('child_process');
const _ = require('lodash');
const AsyncLock = require('async-lock');
const { handleProcessCommunication } = require('../utility/processComm');
const lock = new AsyncLock();
const config = require('./config');
const processArgs = require('../utility/processArgs');
const {
  testConnectionPermission,
  loadPermissionsFromRequest,
  hasPermission,
  loadDatabasePermissionsFromRequest,
  getDatabasePermissionRole,
} = require('../utility/hasPermission');
const { MissingCredentialsError } = require('../utility/exceptions');
const pipeForkLogs = require('../utility/pipeForkLogs');
const { getLogger, extractErrorLogData } = require('dbgate-tools');
const { sendToAuditLog } = require('../utility/auditlog');

const logger = getLogger('serverConnection');

module.exports = {
  opened: [],
  closed: {},
  lastPinged: {},
  requests: {},

  handle_databases(conid, { databases }) {
    const existing = this.opened.find(x => x.conid == conid);
    if (!existing) return;
    existing.databases = databases;
    socket.emitChanged(`database-list-changed`, { conid });
  },
  handle_version(conid, { version }) {
    const existing = this.opened.find(x => x.conid == conid);
    if (!existing) return;
    existing.version = version;
    socket.emitChanged(`server-version-changed`, { conid });
  },
  handle_status(conid, { status }) {
    const existing = this.opened.find(x => x.conid == conid);
    if (!existing) return;
    existing.status = status;
    socket.emitChanged(`server-status-changed`);
  },
  handle_ping() { },
  handle_response(conid, { msgid, ...response }) {
    const [resolve, reject] = this.requests[msgid];
    resolve(response);
    delete this.requests[msgid];
  },

  async ensureOpened(conid) {
    const res = await lock.acquire(conid, async () => {
      const existing = this.opened.find(x => x.conid == conid);
      if (existing) return existing;
      const connection = await connections.getCore({ conid });
      if (!connection) {
        throw new Error(`serverConnections: Connection with conid="${conid}" not found`);
      }
      if (connection.singleDatabase) {
        return null;
      }
      if (connection.passwordMode == 'askPassword' || connection.passwordMode == 'askUser') {
        throw new MissingCredentialsError({ conid, passwordMode: connection.passwordMode });
      }
      if (connection.useRedirectDbLogin) {
        throw new MissingCredentialsError({ conid, redirectToDbLogin: true });
      }
      const subprocess = fork(
        global['API_PACKAGE'] || process.argv[1],
        [
          '--is-forked-api',
          '--start-process',
          'serverConnectionProcess',
          ...processArgs.getPassArgs(),
          // ...process.argv.slice(3),
        ],
        {
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        }
      );
      pipeForkLogs(subprocess);
      const newOpened = {
        conid,
        subprocess,
        databases: [],
        connection,
        status: {
          name: 'pending',
        },
        disconnected: false,
      };
      this.opened.push(newOpened);
      delete this.closed[conid];
      socket.emitChanged(`server-status-changed`);
      subprocess.on('message', message => {
        // @ts-ignore
        const { msgtype } = message;
        if (handleProcessCommunication(message, subprocess)) return;
        if (newOpened.disconnected) return;
        this[`handle_${msgtype}`](conid, message);
      });
      subprocess.on('exit', () => {
        if (newOpened.disconnected) return;
        this.close(conid, false);
      });
      subprocess.on('error', err => {
        logger.error(extractErrorLogData(err), 'DBGM-00119 Error in server connection subprocess');
        if (newOpened.disconnected) return;
        this.close(conid, false);
      });
      subprocess.send({ msgtype: 'connect', ...connection, globalSettings: await config.getSettings() });
      return newOpened;
    });
    return res;
  },

  close(conid, kill = true) {
    const existing = this.opened.find(x => x.conid == conid);
    if (existing) {
      existing.disconnected = true;
      if (kill) {
        try {
          existing.subprocess.kill();
        } catch (err) {
          logger.error(extractErrorLogData(err), 'DBGM-00120 Error killing subprocess');
        }
      }
      this.opened = this.opened.filter(x => x.conid != conid);
      this.closed[conid] = {
        ...existing.status,
        name: 'error',
      };
      socket.emitChanged(`server-status-changed`);
    }
  },

  disconnect_meta: true,
  async disconnect({ conid }, req) {
    await testConnectionPermission(conid, req);
    await this.close(conid, true);
    return { status: 'ok' };
  },

  listDatabases_meta: true,
  async listDatabases({ conid }, req) {
    if (!conid) return [];
    if (conid == '__model') return [];
    const loadedPermissions = await loadPermissionsFromRequest(req);

    await testConnectionPermission(conid, req, loadedPermissions);
    const opened = await this.ensureOpened(conid);
    sendToAuditLog(req, {
      category: 'serverop',
      component: 'ServerConnectionsController',
      action: 'listDatabases',
      event: 'databases.list',
      severity: 'info',
      conid,
      sessionParam: `${conid}`,
      sessionGroup: 'listDatabases',
      message: `Loaded databases for connection`,
    });

    if (!hasPermission(`all-databases`, loadedPermissions)) {
      // filter databases by permissions
      const databasePermissions = await loadDatabasePermissionsFromRequest(req);
      const res = [];
      for (const db of opened?.databases ?? []) {
        const databasePermissionRole = getDatabasePermissionRole(db.id, db.name, databasePermissions);
        if (databasePermissionRole != 'deny') {
          res.push({
            ...db,
            databasePermissionRole,
          });
        }
      }
      return res;
    }

    return opened?.databases ?? [];
  },

  version_meta: true,
  async version({ conid }, req) {
    await testConnectionPermission(conid, req);
    const opened = await this.ensureOpened(conid);
    return opened?.version ?? null;
  },

  serverStatus_meta: true,
  async serverStatus() {
    return {
      ...this.closed,
      ..._.mapValues(_.keyBy(this.opened, 'conid'), 'status'),
    };
  },

  ping_meta: true,
  async ping({ conidArray, strmid }) {
    await Promise.all(
      _.uniq(conidArray).map(async conid => {
        const last = this.lastPinged[conid];
        if (last && new Date().getTime() - last < 30 * 1000) {
          return Promise.resolve();
        }
        this.lastPinged[conid] = new Date().getTime();
        const opened = await this.ensureOpened(conid);
        if (!opened) {
          return Promise.resolve();
        }
        try {
          opened.subprocess.send({ msgtype: 'ping' });
        } catch (err) {
          logger.error(extractErrorLogData(err), 'DBGM-00121 Error pinging server connection');
          this.close(conid);
        }
      })
    );
    socket.setStreamIdFilter(strmid, { conid: [...(conidArray ?? []), '__model'] });
    return { status: 'ok' };
  },

  refresh_meta: true,
  async refresh({ conid, keepOpen }, req) {
    await testConnectionPermission(conid, req);
    if (!keepOpen) this.close(conid);

    await this.ensureOpened(conid);
    return { status: 'ok' };
  },

  async sendDatabaseOp({ conid, msgtype, name }, req) {
    await testConnectionPermission(conid, req);
    const opened = await this.ensureOpened(conid);
    if (!opened) {
      return null;
    }
    if (opened.connection.isReadOnly) return false;
    const res = await this.sendRequest(opened, { msgtype, name });
    if (res.errorMessage) {
      console.error(res.errorMessage);

      return {
        apiErrorMessage: res.errorMessage,
      };
    }
    return res.result || null;
  },

  createDatabase_meta: true,
  async createDatabase({ conid, name }, req) {
    return this.sendDatabaseOp({ conid, msgtype: 'createDatabase', name }, req);
  },

  dropDatabase_meta: true,
  async dropDatabase({ conid, name }, req) {
    return this.sendDatabaseOp({ conid, msgtype: 'dropDatabase', name }, req);
  },

  sendRequest(conn, message) {
    const msgid = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => {
      this.requests[msgid] = [resolve, reject];
      try {
        conn.subprocess.send({ msgid, ...message });
      } catch (err) {
        logger.error(extractErrorLogData(err), 'DBGM-00122 Error sending request');
        this.close(conn.conid);
      }
    });
    return promise;
  },

  async loadDataCore(msgtype, { conid, ...args }, req) {
    await testConnectionPermission(conid, req);
    const opened = await this.ensureOpened(conid);
    if (!opened) {
      return null;
    }
    const res = await this.sendRequest(opened, { msgtype, ...args });
    if (res.errorMessage) {
      console.error(res.errorMessage);

      return {
        errorMessage: res.errorMessage,
      };
    }
    return res.result || null;
  },

  serverSummary_meta: true,
  async serverSummary({ conid }, req) {
    await testConnectionPermission(conid, req);
    logger.info({ conid }, 'DBGM-00260 Processing server summary');
    return this.loadDataCore('serverSummary', { conid });
  },

  listDatabaseProcesses_meta: true,
  async listDatabaseProcesses(ctx, req) {
    const { conid } = ctx;
    // logger.info({ conid }, 'DBGM-00261 Listing processes of database server');
    testConnectionPermission(conid, req);

    const opened = await this.ensureOpened(conid);
    if (!opened) {
      return null;
    }
    if (opened.connection.isReadOnly) return false;

    return this.sendRequest(opened, { msgtype: 'listDatabaseProcesses' });
  },

  killDatabaseProcess_meta: true,
  async killDatabaseProcess(ctx, req) {
    const { conid, pid } = ctx;
    testConnectionPermission(conid, req);

    const opened = await this.ensureOpened(conid);
    if (!opened) {
      return null;
    }
    if (opened.connection.isReadOnly) return false;

    return this.sendRequest(opened, { msgtype: 'killDatabaseProcess', pid });
  },

  summaryCommand_meta: true,
  async summaryCommand({ conid, command, row }, req) {
    await testConnectionPermission(conid, req);
    const opened = await this.ensureOpened(conid);
    if (!opened) {
      return null;
    }
    if (opened.connection.isReadOnly) return false;
    return this.loadDataCore('summaryCommand', { conid, command, row });
  },

  getOpenedConnectionReport() {
    return this.opened.map(con => ({
      status: con.status,
      versionText: con.version?.versionText,
      databaseCount: con.databases.length,
      connection: _.pick(con.connection, [
        'engine',
        'useSshTunnel',
        'authType',
        'trustServerCertificate',
        'useSsl',
        'sshMode',
      ]),
    }));
  },
};
