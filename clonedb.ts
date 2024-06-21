const { DynamoDBClient, ListTablesCommand, CreateBackupCommand, DescribeBackupCommand, ListBackupsCommand, RestoreTableFromBackupCommand, DeleteTableCommand, DescribeTableCommand } = require("@aws-sdk/client-dynamodb");
const { STSClient, AssumeRoleCommand } = require("@aws-sdk/client-sts");
const prompt = require('prompt');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Configurazione degli ambienti
const region = 'eu-west-1'; // Regione per entrambi gli account
const startTablePrefix = 'riale-calendar-production'; // Prefisso per le tabelle di partenza
const targetTablePrefix = 'riale-calendar-stage'; // Prefisso per le tabelle di destinazione

// Configurazione del role ARN per gli account
const roleArnA = 'arn:aws:iam::740820033840:role/OrganizationAccountAccessRole'; // Ruolo per il backup su Account A
const roleArnB = 'arn:aws:iam::740820033840:role/OrganizationAccountAccessRole'; // Ruolo per il ripristino su Account B

// Funzione per assumere un ruolo e ottenere credenziali temporanee
async function assumeRole(roleArn) {
  const stsClient = new STSClient({});
  const command = new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: 'DynamoDBBackupRestoreSession',
  });
  const data = await stsClient.send(command);
  return {
    accessKeyId: data.Credentials.AccessKeyId,
    secretAccessKey: data.Credentials.SecretAccessKey,
    sessionToken: data.Credentials.SessionToken,
  };
}

// Funzione per creare un client DynamoDB con credenziali temporanee
async function createDynamoDBClient(region, credentials) {
  return new DynamoDBClient({
    region: region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken
    }
  });
}

// Funzione per ottenere tutte le tabelle
async function listAllTables(dynamodbClient) {
  let tables = [];
  let lastEvaluatedTableName = undefined;

  do {
    const command = new ListTablesCommand({ ExclusiveStartTableName: lastEvaluatedTableName });
    const data = await dynamodbClient.send(command);
    tables = tables.concat(data.TableNames);
    lastEvaluatedTableName = data.LastEvaluatedTableName;
  } while (lastEvaluatedTableName);

  return tables;
}

// Funzione per ottenere le tabelle con un determinato prefisso
async function getTablesWithPrefix(dynamodbClient, prefix) {
  const allTables = await listAllTables(dynamodbClient);
  console.log("Lista di tutte le tabelle:", allTables);
  await promptForContinue();

  const filteredTables = allTables.filter(tableName => tableName.startsWith(prefix));
  console.log(`Lista delle tabelle che iniziano con il prefisso "${prefix}":`, filteredTables);

  const confirmed = await askConfirmationToProceed(filteredTables);
  if (!confirmed) {
    console.log("Operazione annullata dall'utente.");
    process.exit(0); // Termina il processo
  }
  return filteredTables;
}

// Funzione per creare un backup di una tabella
async function createBackup(dynamodbClient, tableName) {
  const backupName = `${tableName}-backup`;
  const command = new CreateBackupCommand({
    TableName: tableName,
    BackupName: backupName,
  });
  const data = await dynamodbClient.send(command);
  return data.BackupDetails.BackupArn;
}

// Funzione per attendere il completamento di un backup
async function waitForBackupCompletion(dynamodbClient, backupArn) {
  let backupCompleted = false;
  while (!backupCompleted) {
    const command = new DescribeBackupCommand({
      BackupArn: backupArn,
    });
    const data = await dynamodbClient.send(command);
    if (data.BackupDescription.BackupDetails.BackupStatus === 'AVAILABLE') {
      backupCompleted = true;
    } else {
      await sleep(5000); // Attendi 5 secondi prima di riprovare
    }
  }
}

// Funzione per ottenere i backup di una tabella
async function getBackups(dynamodbClient, tableName) {
  const command = new ListBackupsCommand({
    TableName: tableName
  });
  const data = await dynamodbClient.send(command);
  return data.BackupSummaries;
}

// Funzione per verificare se una tabella esiste
async function tableExists(dynamodbClient, tableName) {
  try {
    const command = new DescribeTableCommand({
      TableName: tableName
    });
    await dynamodbClient.send(command);
    return true;
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      return false;
    }
    throw error;
  }
}

// Funzione per eliminare una tabella
async function deleteTable(dynamodbClient, tableName) {
  const command = new DeleteTableCommand({
    TableName: tableName
  });
  await dynamodbClient.send(command);

  // Attendere che la tabella venga eliminata
  let tableDeleted = false;
  while (!tableDeleted) {
    try {
      await dynamodbClient.send(new DescribeTableCommand({ TableName: tableName }));
      await sleep(5000); // Attendere 5 secondi prima di riprovare
    } catch (error) {
      if (error.name === 'ResourceNotFoundException') {
        tableDeleted = true;
      } else {
        throw error;
      }
    }
  }
}

// Funzione per ripristinare una tabella da un backup
async function restoreTableFromBackup(dynamodbClient, backupArn, newTableName) {
  // Eliminare la tabella se esiste già
  if (await tableExists(dynamodbClient, newTableName)) {
    console.log(`Tabella ${newTableName} esiste già. Eliminazione in corso...`);
    await deleteTable(dynamodbClient, newTableName);
    console.log(`Tabella ${newTableName} eliminata con successo.`);
  }

  // Ripristinare la tabella dal backup
  const command = new RestoreTableFromBackupCommand({
    TargetTableName: newTableName,
    BackupArn: backupArn,
  });
  const data = await dynamodbClient.send(command);
  return data.TableDescription;
}

// Funzione per chiedere conferma all'utente
async function askConfirmation(tables) {
  console.log("Le seguenti tabelle verranno sovrascritte:");
  tables.forEach(table => console.log(table));
  prompt.start();
  const { confirm } = await prompt.get({
    name: 'confirm',
    description: 'Vuoi continuare con il ripristino? (s/n)',
    type: 'string',
    required: true,
    conform: value => ['s', 'n'].includes(value.toLowerCase())
  });
  return confirm.toLowerCase() === 's';
}

// Funzione per chiedere conferma all'utente prima di procedere
async function askConfirmationToProceed(tables) {
  console.log("Le seguenti tabelle verranno elaborate:");
  tables.forEach(table => console.log(table));
  prompt.start();
  const { confirm } = await prompt.get({
    name: 'confirm',
    description: 'Vuoi continuare con l\'operazione? (s/n)',
    type: 'string',
    required: true,
    conform: value => ['s', 'n'].includes(value.toLowerCase())
  });
  return confirm.toLowerCase() === 's';
}

// Funzione per chiedere all'utente di premere invio per continuare
async function promptForContinue() {
  prompt.start();
  await prompt.get({
    name: 'continue',
    description: 'Premi invio per continuare',
    required: false, // Permette l'input vuoto
  });
}

// Funzione principale
async function main() {
  try {
    // Assumere il ruolo su Account A e ottenere credenziali temporanee per il backup
    const credentialsA = await assumeRole(roleArnA);
    const prodDynamoDB = await createDynamoDBClient(region, credentialsA);

    // Passaggio 1: Trova tutte le tabelle di partenza con il prefisso specificato
    const startTables = await getTablesWithPrefix(prodDynamoDB, startTablePrefix);

    // Passaggio 2: Esegui il backup di ogni tabella di partenza in parallelo
    const backupPromises = startTables.map(async (tableName) => {
      try {
        console.log(`Creazione del backup per la tabella ${tableName}...`);
        const backupArn = await createBackup(prodDynamoDB, tableName);

        console.log(`Attesa del completamento del backup per la tabella ${tableName}...`);
        await waitForBackupCompletion(prodDynamoDB, backupArn);

        console.log(`Backup creato per la tabella ${tableName} con successo: ${backupArn}`);
        return { tableName, backupArn };
      } catch (error) {
        console.error(`Errore durante il processo di backup per la tabella ${tableName}:`, error);
        return null;
      }
    });

    const backupResults = await Promise.all(backupPromises);
    const successfulBackups = backupResults.filter(result => result !== null);

    // Assumere il ruolo su Account B e ottenere credenziali temporanee per il ripristino
    const credentialsB = await assumeRole(roleArnB);
    const devDynamoDB = await createDynamoDBClient(region, credentialsB);

    // Passaggio 3: Verifica le tabelle che verranno sovrascritte
    const tablesToOverwrite = await Promise.all(successfulBackups.map(async ({ tableName }) => {
      const newTableName = tableName.replace(startTablePrefix, targetTablePrefix);
      if (await tableExists(devDynamoDB, newTableName)) {
        return newTableName;
      }
      return null;
    }));

    const filteredTablesToOverwrite = tablesToOverwrite.filter(table => table !== null);
    if (filteredTablesToOverwrite.length > 0) {
      const confirmed = await askConfirmation(filteredTablesToOverwrite);
      if (!confirmed) {
        console.log("Operazione annullata dall'utente.");
        return;
      }
    }

    // Passaggio 4: Ripristina le tabelle da Account A a Account B in parallelo
    const restorePromises = successfulBackups.map(async ({ tableName, backupArn }) => {
      try {
        const newTableName = tableName.replace(startTablePrefix, targetTablePrefix);
        console.log(`Ripristino della tabella ${tableName} come ${newTableName}...`);

        await restoreTableFromBackup(devDynamoDB, backupArn, newTableName);

        console.log(`Tabella ${tableName} ripristinata come ${newTableName} con successo.`);
      } catch (error) {
        console.error(`Errore durante il processo di ripristino per la tabella ${tableName}:`, error);
      }
    });

    await Promise.all(restorePromises);

    console.log("Processo completato.");
  } catch (error) {
    console.error("Errore durante il processo:", error);
  }
}

main();
