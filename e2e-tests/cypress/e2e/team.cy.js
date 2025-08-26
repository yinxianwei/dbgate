Cypress.on('uncaught:exception', (err, runnable) => {
  // if the error message matches the one about WorkerGlobalScope importScripts
  if (err.message.includes("Failed to execute 'importScripts' on 'WorkerGlobalScope'")) {
    // return false to let Cypress know we intentionally want to ignore this error
    return false;
  }
  // otherwise let Cypress throw the error
});

beforeEach(() => {
  cy.visit('http://localhost:3000');
  cy.viewport(1250, 900);
});

describe('Team edition tests', () => {
  it('Team edition screens', () => {
    cy.testid('LoginPage_linkAdmin').click();
    cy.testid('LoginPage_password').type('adminpwd');
    cy.testid('LoginPage_submitLogin').click();

    cy.testid('AdminMenuWidget_itemConnections').click();
    cy.contains('New connection').click();
    cy.testid('ConnectionDriverFields_connectionType').select('PostgreSQL');
    cy.contains('not granted').should('not.exist');
    cy.themeshot('connection-administration');

    cy.testid('AdminMenuWidget_itemRoles').click();
    cy.contains('logged-user').click();
    cy.contains('not granted').should('not.exist');
    cy.themeshot('role-administration');

    cy.testid('AdminMenuWidget_itemUsers').click();
    cy.contains('New user').click();
    cy.contains('not granted').should('not.exist');
    cy.themeshot('user-administration');

    cy.testid('AdminMenuWidget_itemAuthentication').click();
    cy.contains('Add authentication').click();
    cy.contains('Use database login').click();
    cy.contains('Add authentication').click();
    cy.contains('OAuth 2.0').click();
    cy.contains('not granted').should('not.exist');
    cy.themeshot('authentication-administration');
  });

  it('OAuth authentication', () => {
    cy.testid('LoginPage_linkAdmin').click();
    cy.testid('LoginPage_password').type('adminpwd');
    cy.testid('LoginPage_submitLogin').click();
    cy.testid('AdminMenuWidget_itemAuthentication').click();
    // cy.testid('AdminAuthForm_disableButton_local').click();
    // cy.testid('AdminAuthForm_disableButton_none').click();

    // fill OAuth
    cy.contains('Add authentication').click();
    cy.contains('OAuth 2.0').click();
    cy.testid('AdminAuthForm_oauthAuth_oauth').type('http://localhost:16009/dex/auth');
    cy.testid('AdminAuthForm_oauthToken_oauth').type('http://localhost:16009/dex/token');
    cy.testid('AdminAuthForm_oauthScope_oauth').type('openid email profile');
    cy.testid('AdminAuthForm_oauthClient_oauth').type('my-app');
    cy.testid('AdminAuthForm_oauthClientSecret_oauth').type('my-secret');
    cy.testid('AdminAuthForm_oauthLoginField_oauth').type('name');
    cy.testid('AdminAuthForm_oauthSaveNotDefinedLogins_oauth').click();
    cy.testid('AdminAuthForm_oauthEmailField_oauth').type('email');
    cy.testid('AdminAuthTab_saveButton').click();

    cy.testid('WidgetIconPanel_menu').click();
    cy.contains('File').click();
    cy.contains('Logout').click();
    cy.testid('LoginPage_linkRegularUser').click();

    // login two times
    for (let index of [1, 2]) {
      // login as OAuth
      cy.testid('LoginPage_loginButton_OAuth 2.0').click();

      // login on DEX
      cy.get('#login').clear().type('test@example.com');
      cy.get('#password').clear().type('test');
      cy.get('#submit-login').click();

      // logout
      cy.testid('WidgetIconPanel_menu').click();
      cy.contains('File').click();
      cy.contains('Logout').click();
      cy.testid('NotLoggedPage_loginButton').click();
    }

    // Logout and login again as admin
    cy.testid('LoginPage_linkAdmin').click();
    cy.testid('LoginPage_password').type('adminpwd');
    cy.testid('LoginPage_submitLogin').click();
    cy.testid('AdminMenuWidget_itemUsers').click();
    cy.contains('test@example.com');
  });

  it('Audit logging', () => {
    cy.testid('LoginPage_linkAdmin').click();
    cy.testid('LoginPage_password').type('adminpwd');
    cy.testid('LoginPage_submitLogin').click();

    cy.testid('AdminMenuWidget_itemAuditLog').click();
    cy.contains('Audit log is not enabled');
    cy.testid('AdminMenuWidget_itemSettings').click();
    cy.testid('AdminSettingsTab_auditLogCheckbox').click();
    cy.testid('AdminMenuWidget_itemAuditLog').click();
    cy.contains('No data for selected date');

    cy.testid('AdminMenuWidget_itemConnections').click();
    cy.contains('Open table').click();
    cy.contains('displayName');
    cy.get('.toolstrip').contains('Export').click();
    cy.contains('CSV file').click();

    cy.testid('AdminMenuWidget_itemUsers').click();
    cy.contains('Open table').click();
    cy.contains('login');
    cy.get('.toolstrip').contains('Export').click();
    cy.contains('XML file').click();

    cy.testid('AdminMenuWidget_itemAuditLog').click();
    cy.testid('AdminAuditLogTab_refreshButton').click();
    cy.contains('Exporting query').click();
    cy.themeshot('auditlog');
  });

  it('Edit database permissions', () => {
    cy.testid('LoginPage_linkAdmin').click();
    cy.testid('LoginPage_password').type('adminpwd');
    cy.testid('LoginPage_submitLogin').click();

    cy.testid('AdminMenuWidget_itemRoles').click();
    cy.testid('AdminRolesTab_table').contains('superadmin').click();
    cy.testid('AdminRolesTab_databases').click();

    cy.testid('AdminDatabasesPermissionsGrid_addButton').click();
    cy.testid('AdminDatabasesPermissionsGrid_addButton').click();
    cy.testid('AdminDatabasesPermissionsGrid_addButton').click();
    
    cy.testid('AdminListOrRegexEditor_1_regexInput').type('^Chinook[\\d]*$');
    cy.testid('AdminListOrRegexEditor_2_listSwitch').click();
    cy.testid('AdminListOrRegexEditor_2_listInput').type('Nortwind\nSales');
    cy.testid('AdminDatabasesPermissionsGrid_roleSelect_0').select('-2');
    cy.testid('AdminDatabasesPermissionsGrid_roleSelect_1').select('-3');
    cy.testid('AdminDatabasesPermissionsGrid_roleSelect_2').select('-4');

    cy.contains('not granted').should('not.exist');

    cy.themeshot('database-permissions');
  });
});
