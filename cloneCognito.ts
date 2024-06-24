const { CognitoIdentityProviderClient, DescribeUserPoolCommand, CreateUserPoolCommand, ListUserPoolsCommand, CreateUserPoolClientCommand, ListUserPoolClientsCommand, DescribeUserPoolClientCommand, CreateGroupCommand, ListGroupsCommand, ListUsersCommand, AdminCreateUserCommand, AdminAddUserToGroupCommand, AdminListGroupsForUserCommand, AdminGetUserCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { fromTemporaryCredentials } = require('@aws-sdk/credential-providers');

const region = 'eu-west-1'; // Regione per entrambi gli account
const sourceUserPoolPrefix = 'riale-calendar-production'; // Prefisso per gli User Pool di sviluppo
const targetUserPoolPrefix = 'riale-calendar-stage'; // Prefisso per gli User Pool di produzione

const roleArnA = 'arn:aws:iam::740820033840:role/OrganizationAccountAccessRole'; // Ruolo per l'accesso all'Account A
const roleArnB = 'arn:aws:iam::740820033840:role/OrganizationAccountAccessRole'; // Ruolo per l'accesso all'Account B

const isCustomSub = false; // Modifica questa variabile a 'true' se 'sub' è un attributo personalizzato, altrimenti 'false'

// Funzione per creare un client Cognito con credenziali temporanee
async function createCognitoClient(roleArn) {
  const stsClient = new STSClient({ region });
  const assumeRoleCommand = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'CognitoCloneSession',
  });
  const data = await stsClient.send(assumeRoleCommand);
  const credentials = {
    accessKeyId: data.Credentials.AccessKeyId,
    secretAccessKey: data.Credentials.SecretAccessKey,
    sessionToken: data.Credentials.SessionToken,
  };

  return new CognitoIdentityProviderClient({ region, credentials });
}

// Funzione per ottenere gli User Pool con un determinato prefisso
async function getUserPoolsWithPrefix(cognitoClient, prefix) {
  const command = new ListUserPoolsCommand({ MaxResults: 60 });
  const data = await cognitoClient.send(command);
  return data.UserPools?.filter(pool => pool.Name.startsWith(prefix)) || [];
}

// Funzione per clonare un User Pool
async function cloneUserPool(sourceCognito, targetCognito, sourceUserPoolId, targetUserPoolName) {
  // Ottieni le configurazioni dell'User Pool sorgente
  const describeUserPoolCommand = new DescribeUserPoolCommand({ UserPoolId: sourceUserPoolId });
  const describeUserPoolResponse = await sourceCognito.send(describeUserPoolCommand);
  const userPoolConfig = describeUserPoolResponse.UserPool;

  // Filtra gli attributi predefiniti dallo schema
  const filteredSchema = userPoolConfig.SchemaAttributes?.filter(attr => !['phone_number_verified', 'email_verified', 'phone_number', 'email'].includes(attr.Name));

  // Crea un nuovo User Pool di destinazione con le stesse configurazioni
  const createUserPoolCommand = new CreateUserPoolCommand({
    PoolName: targetUserPoolName,
    Policies: userPoolConfig.Policies,
    LambdaConfig: userPoolConfig.LambdaConfig,
    AutoVerifiedAttributes: userPoolConfig.AutoVerifiedAttributes,
    Schema: filteredSchema,
    // Aggiungi altre configurazioni necessarie qui
  });
  const createUserPoolResponse = await targetCognito.send(createUserPoolCommand);
  const targetUserPoolId = createUserPoolResponse.UserPool.Id;

  console.log(`User Pool ${targetUserPoolName} creato con successo: ${targetUserPoolId}`);

  // Clona i client dell'User Pool
  await cloneUserPoolClients(sourceCognito, targetCognito, sourceUserPoolId, targetUserPoolId);

  // Clona i gruppi dell'User Pool
  await cloneUserPoolGroups(sourceCognito, targetCognito, sourceUserPoolId, targetUserPoolId);

  // Clona gli utenti dell'User Pool
  await cloneUserPoolUsers(sourceCognito, targetCognito, sourceUserPoolId, targetUserPoolId, isCustomSub);

  // Puoi aggiungere qui la clonazione di altre configurazioni come trigger, politiche, ecc.
}

// Funzione per clonare i client di un User Pool
async function cloneUserPoolClients(sourceCognito, targetCognito, sourceUserPoolId, targetUserPoolId) {
  const listUserPoolClientsCommand = new ListUserPoolClientsCommand({ UserPoolId: sourceUserPoolId });
  const listUserPoolClientsResponse = await sourceCognito.send(listUserPoolClientsCommand);
  const clients = listUserPoolClientsResponse.UserPoolClients;

  for (const client of clients) {
    const describeUserPoolClientCommand = new DescribeUserPoolClientCommand({ UserPoolId: sourceUserPoolId, ClientId: client.ClientId });
    const describeUserPoolClientResponse = await sourceCognito.send(describeUserPoolClientCommand);
    const clientConfig = describeUserPoolClientResponse.UserPoolClient;

    const createUserPoolClientCommand = new CreateUserPoolClientCommand({
      UserPoolId: targetUserPoolId,
      ClientName: clientConfig.ClientName,
      GenerateSecret: clientConfig.GenerateSecret,
      RefreshTokenValidity: clientConfig.RefreshTokenValidity,
      ReadAttributes: clientConfig.ReadAttributes,
      WriteAttributes: clientConfig.WriteAttributes,
      ExplicitAuthFlows: clientConfig.ExplicitAuthFlows,
      // Aggiungi altre configurazioni necessarie qui
    });

    await targetCognito.send(createUserPoolClientCommand);
    console.log(`Client ${clientConfig.ClientName} creato con successo nell'User Pool ${targetUserPoolId}`);
  }
}

// Funzione per clonare i gruppi di un User Pool
async function cloneUserPoolGroups(sourceCognito, targetCognito, sourceUserPoolId, targetUserPoolId) {
  const listGroupsCommand = new ListGroupsCommand({ UserPoolId: sourceUserPoolId });
  const listGroupsResponse = await sourceCognito.send(listGroupsCommand);
  const groups = listGroupsResponse.Groups;

  for (const group of groups) {
    const createGroupCommand = new CreateGroupCommand({
      UserPoolId: targetUserPoolId,
      GroupName: group.GroupName,
      Description: group.Description,
      Precedence: group.Precedence,
      RoleArn: group.RoleArn,
    });

    await targetCognito.send(createGroupCommand);
    console.log(`Gruppo ${group.GroupName} creato con successo nell'User Pool ${targetUserPoolId}`);
  }
}

// Funzione per clonare gli utenti di un User Pool
async function cloneUserPoolUsers(sourceCognito, targetCognito, sourceUserPoolId, targetUserPoolId, isCustomSub) {
  let paginationToken;
  do {
    const listUsersCommand = new ListUsersCommand({ UserPoolId: sourceUserPoolId, PaginationToken: paginationToken });
    const listUsersResponse = await sourceCognito.send(listUsersCommand);
    const users = listUsersResponse.Users;

    for (const user of users) {
      // Filtra l'attributo 'sub' se non è personalizzato
      const userAttributes = user.Attributes.filter(attr => isCustomSub || attr.Name !== 'sub').map(attr => ({ Name: attr.Name, Value: attr.Value }));

      const adminCreateUserCommand = new AdminCreateUserCommand({
        UserPoolId: targetUserPoolId,
        Username: user.Username,
        UserAttributes: userAttributes,
        MessageAction: 'SUPPRESS' // Suppress the invitation message
      });

      await targetCognito.send(adminCreateUserCommand);
      console.log(`Utente ${user.Username} creato con successo nell'User Pool ${targetUserPoolId}`);

      // Riduci il ritardo per garantire che l'utente sia completamente creato prima di aggiungerlo ai gruppi
      await sleep(5000); // 5 secondi di ritardo

      // Verifica che l'utente esista nel nuovo User Pool
      let userExists = false;
      for (let attempt = 0; attempt < 3; attempt++) { // Tenta fino a 3 volte
        try {
          const adminGetUserCommand = new AdminGetUserCommand({
            UserPoolId: targetUserPoolId,
            Username: user.Username,
          });
          await targetCognito.send(adminGetUserCommand);
          userExists = true;
          break;
        } catch (error) {
          if (error.name === 'UserNotFoundException') {
            console.log(`Tentativo ${attempt + 1}: Utente ${user.Username} non trovato, ritento tra 1 secondo...`);
            await sleep(1000); // Aspetta 1 secondo prima di riprovare
          } else {
            throw error;
          }
        }
      }

      if (!userExists) {
        console.error(`Impossibile trovare l'utente ${user.Username} nel nuovo User Pool dopo più tentativi.`);
        continue;
      }

      // Clona le appartenenze ai gruppi
      try {
        const listGroupsForUserCommand = new AdminListGroupsForUserCommand({ UserPoolId: sourceUserPoolId, Username: user.Username });
        const listGroupsForUserResponse = await sourceCognito.send(listGroupsForUserCommand);
        const userGroups = listGroupsForUserResponse.Groups;

        if (userGroups) {
          for (const group of userGroups) {
            const adminAddUserToGroupCommand = new AdminAddUserToGroupCommand({
              UserPoolId: targetUserPoolId,
              Username: user.Username,
              GroupName: group.GroupName
            });

            await targetCognito.send(adminAddUserToGroupCommand);
            console.log(`Utente ${user.Username} aggiunto al gruppo ${group.GroupName} nell'User Pool ${targetUserPoolId}`);
          }
        }
      } catch (error) {
        console.error(`Errore durante l'aggiunta dell'utente ${user.Username} ai gruppi:`, error.message);
      }
    }

    paginationToken = listUsersResponse.PaginationToken;
  } while (paginationToken);
}

// Funzione di sleep per aggiungere ritardi
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Funzione principale
async function main() {
  try {
    // Crea client Cognito per Account A e B
    const sourceCognito = await createCognitoClient(roleArnA);
    const targetCognito = await createCognitoClient(roleArnB);

    // Ottieni tutti gli User Pool di sviluppo con il prefisso specificato
    const sourceUserPools = await getUserPoolsWithPrefix(sourceCognito, sourceUserPoolPrefix);

    // Per ogni User Pool di sviluppo, clona il contenuto nel corrispondente User Pool di produzione
    for (const sourceUserPool of sourceUserPools) {
      const sourceUserPoolId = sourceUserPool.Id;
      const targetUserPoolName = sourceUserPool.Name.replace(sourceUserPoolPrefix, targetUserPoolPrefix);

      await cloneUserPool(sourceCognito, targetCognito, sourceUserPoolId, targetUserPoolName);
    }

    console.log('Clonazione di tutti gli User Pool completata con successo!');
  } catch (error) {
    console.error('Errore durante la clonazione:', error.message);
  }
}

main();
