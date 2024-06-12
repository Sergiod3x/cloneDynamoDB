const { DynamoDBClient, ListTablesCommand, CreateBackupCommand, DescribeBackupCommand, ListBackupsCommand, RestoreTableFromBackupCommand } = require("@aws-sdk/client-dynamodb");
const { STSClient, AssumeRoleCommand } = require("@aws-sdk/client-sts");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Configurazione degli ambienti
const prodRegion = 'eu-west-1'; // Regione di produzione per entrambi gli account
const prodPrefix = 'riale-calendar-production-';
const devPrefix = 'riale-calendar-dev2-';

// Configurazione del role ARN per gli account
const roleArnA = 'arn:aws:iam::475192682913:role/OrganizationAccountAccessRole'; // Ruolo per il backup su Account A
const roleArnB = 'arn:aws:iam::475192682913:role/OrganizationAccountAccessRole'; // Ruolo per il ripristino su Account B

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

async function getTablesWithPrefix(dynamodbClient, prefix) {
  const command = new ListTablesCommand({});
  const data = await dynamodbClient.send(command);
  return data.TableNames.filter(tableName => tableName.startsWith(prefix));
}

async function createBackup(dynamodbClient, tableName) {
  const backupName = `${tableName}-backup`;
  const command = new CreateBackupCommand({
    TableName: tableName,
    BackupName: backupName,
  });
  const data = await dynamodbClient.send(command);
  return data.BackupDetails.BackupArn;
}

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

async function getBackups(dynamodbClient, tableName) {
  const command = new ListBackupsCommand({
    TableName: tableName
  });
  const data = await dynamodbClient.send(command);
  return data.BackupSummaries;
}

async function restoreTableFromBackup(dynamodbClient, backupArn, newTableName) {
  const command = new RestoreTableFromBackupCommand({
    TargetTableName: newTableName,
    BackupArn: backupArn,
  });
  const data = await dynamodbClient.send(command);
  return data.TableDescription;
}

async function main() {
  try {
    // Assume Role on Account A and get temporary credentials for backup
    const credentialsA = await assumeRole(roleArnA);
    const prodDynamoDB = await createDynamoDBClient(prodRegion, credentialsA);

    // Step 1: Trova tutte le tabelle di produzione con il prefisso specificato
    const prodTables = await getTablesWithPrefix(prodDynamoDB, prodPrefix);

    // Step 2: Esegui il backup di ogni tabella di produzione
    for (const tableName of prodTables) {
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

    // Assume Role on Account B and get temporary credentials for restore
    const credentialsB = await assumeRole(roleArnB);
    const devDynamoDB = await createDynamoDBClient(prodRegion, credentialsB);

    // Step 3: Ripristina le tabelle da Account A a Account B
    for (const tableName of prodTables) {
      try {
        const newTableName = tableName.replace(prodPrefix, devPrefix);
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
