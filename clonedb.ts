const { DynamoDBClient, ListTablesCommand, CreateBackupCommand, DescribeBackupCommand, ListBackupsCommand, RestoreTableFromBackupCommand } = require("@aws-sdk/client-dynamodb");
const { STSClient, AssumeRoleCommand } = require("@aws-sdk/client-sts");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Configurazione degli ambienti
const region = 'eu-west-1'; // Regione per entrambi gli account
const startTablePrefix = 'riale-calendar-production-'; // Prefisso per le tabelle di partenza
const targetTablePrefix = 'riale-calendar-dev4-'; // Prefisso per le tabelle di destinazione

// Configurazione del role ARN per gli account
const roleArnA = 'arn:aws:iam::475192682913:role/OrganizationAccountAccessRole'; // Ruolo per il backup su Account A
const roleArnB = 'arn:aws:iam::475192682913:role/OrganizationAccountAccessRole'; // Ruolo per il ripristino su Account B

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

// Funzione per ottenere le tabelle con un determinato prefisso
async function getTablesWithPrefix(dynamodbClient, prefix) {
  const command = new ListTablesCommand({});
  const data = await dynamodbClient.send(command);
  return data.TableNames.filter(tableName => tableName.startsWith(prefix));
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

// Funzione per ripristinare una tabella da un backup
async function restoreTableFromBackup(dynamodbClient, backupArn, newTableName) {
  const command = new RestoreTableFromBackupCommand({
    TargetTableName: newTableName,
    BackupArn: backupArn,
  });
  const data = await dynamodbClient.send(command);
  return data.TableDescription;
}

// Funzione principale
async function main() {
  try {
    // Assumere il ruolo su Account A e ottenere credenziali temporanee per il backup
    const credentialsA = await assumeRole(roleArnA);
    const prodDynamoDB = await createDynamoDBClient(region, credentialsA);

    // Passaggio 1: Trova tutte le tabelle di partenza con il prefisso specificato
    const startTables = await getTablesWithPrefix(prodDynamoDB, startTablePrefix);

    // Passaggio 2: Esegui il backup di ogni tabella di partenza
    for (const tableName of startTables) {
      try {
        console.log(`Creazione del backup per la tabella ${tableName}...`);
        const backupArn = await createBackup(prodDynamoDB, tableName);

        console.log(`Attesa del completamento del backup per la tabella ${tableName}...`);
        await waitForBackupCompletion(prodDynamoDB, backupArn);

        console.log(`Backup creato per la tabella ${tableName} con successo: ${backupArn}`);
      } catch (error) {
        console.error(`Errore durante il processo di backup per la tabella ${tableName}:`, error);
      }
    }

    // Assumere il ruolo su Account B e ottenere credenziali temporanee per il ripristino
    const credentialsB = await assumeRole(roleArnB);
    const devDynamoDB = await createDynamoDBClient(region, credentialsB);

    // Passaggio 3: Ripristina le tabelle da Account A a Account B
    for (const tableName of startTables) {
      try {
        const newTableName = tableName.replace(startTablePrefix, targetTablePrefix);
        console.log(`Ripristino della tabella ${tableName} come ${newTableName}...`);
        
        // Trova l'ultimo backup per la tabella
        const backups = await getBackups(prodDynamoDB, tableName);
        const latestBackup = backups.reduce((latest, backup) => {
          return new Date(backup.BackupCreationDateTime) > new Date(latest.BackupCreationDateTime) ? backup : latest;
        });

        await restoreTableFromBackup(devDynamoDB, latestBackup.BackupArn, newTableName);

        console.log(`Tabella ${tableName} ripristinata come ${newTableName} con successo.`);
      } catch (error) {
        console.error(`Errore durante il processo di ripristino per la tabella ${tableName}:`, error);
      }
    }

    console.log("Processo completato.");
  } catch (error) {
    console.error("Errore durante il processo:", error);
  }
}

main();
